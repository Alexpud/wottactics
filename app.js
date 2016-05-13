var fs = require('fs');
var secrets = JSON.parse(fs.readFileSync('secrets.txt', 'utf8'));
var http = require('http');
var escaper = require('mongo-key-escape');

room_data = {} //room -> room_data map to be shared with clients

//generates unique id
function newUid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,
    function(c) {
      var r = Math.random() * 16 | 0,
        v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }).toUpperCase();
}

var compress = require('compression');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var bodyParser = require('body-parser');
var logger = require('morgan');
var passport = require('passport');

var app = express();
app.use(compress());
app.use(bodyParser.json({limit: '50mb', extended: true}));
app.use(bodyParser.urlencoded({limit: '50mb', extended: true}));
  
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// creating new socket.io app
var io = require('socket.io')({
  transports: [
    'websocket', 
    'flashsocket', 
    'htmlfile', 
    'xhr-polling', 
    'jsonp-polling', 
    'polling'
  ]
});

//configure localization support
var i18n = require('i18n');
var locales = ['en', 'sr', 'de', 'es', 'fr', 'pl', 'cs', 'fi', 'ru'];
i18n.configure({
	locales: locales,
	directory: __dirname + "/locales",
	updateFiles: true
});
app.locals.l = i18n.__;
app.locals.ln = i18n.__n;

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});

// not pretty but oh so handy to not crash the server
process.on('uncaughtException', function (err) {
 	console.log(err);
	console.log(err.stack);	
});

//load mongo
connection_string =  secrets.mongodb_string;

console.log("Connecting to: ", connection_string)

MongoClient = require('mongodb').MongoClient;
MongoClient.connect('mongodb://'+connection_string, function(err, db) {
	if(err) throw err;	
	
	db.authenticate(secrets.mongodb_username, secrets.mongodb_password, function(err, result) {	
	if(err) throw err;	
	
	db.createCollection('tactics');
	db.createCollection('clans');
	db.collection('tactics').createIndex( { "createdAt": 1 }, { expireAfterSeconds: 31622400 } );

	function clean_up_room(room) {
		setTimeout( function() {
			if (room_data[room]) {
				if (!io.sockets.adapter.rooms[room]) {
					if (Date.now() - room_data[room].last_join > 50000) {
						save_room(room, function() {
							delete room_data[room];
						});
					} else {
						clean_up_room(room); //try again
					}
				}
			}
		}, 60000);
	}
	
	function save_room(room, cb) {
		room_data[room]._id = room;
		db.collection('tactics').update({_id:room}, room_data[room], {upsert: true}, function (err, result) {
		  cb();
		});
	}
	
	function get_tactics(identity, game, cb) {
		if (identity) {
			db.collection('users').findOne({_id:identity},{'tactics':1, 'rooms':1}, function(err, data) {
				if (!err) {
					if (data) {
						var tactics = [], rooms = [];
						if (data.tactics) {
							tactics = data.tactics;
						}
						if (data.rooms) {
							rooms = data.rooms;
						}
						cb(tactics, rooms);
					} else {
						cb([],[]);
					}
				} else {
					cb([],[]);
				}
			});
		} else {
			cb([],[]);
		}
	}	
	
	
	function push_tactic_to_db(user, room, name, uid) {
		//store a link to the tacticn in user data
		db.collection('users').update({_id:user.identity}, {$push:{tactics:{name:name, date:Date.now(), game:room_data[room].game, uid:uid}}}, {upsert: true});		
		//store the tactic in the stored_tactics list
		var data = JSON.parse(JSON.stringify(room_data[room]));
		data.name = name;
		delete data.userlist;
		delete data.lost_users;
		delete data.lost_identities;
		data._id = uid;
		db.collection('stored_tactics').update({_id:uid}, data, {upsert: true});

		if (!room_data[room].lost_identities[user.identity]) {
			room_data[room].lost_identities[user.identity] = {};
		}
		room_data[room].lost_identities[user.identity].tactic_name = name;
		room_data[room].lost_identities[user.identity].tactic_uid = uid;
	}
	
	function store_tactic(user, room, name) {
		if (room_data[room] && user.identity) { //room exists, user is logged in
			if (room_data[room].lost_identities[user.identity]
				&& room_data[room].lost_identities[user.identity].tactic_uid
				&& room_data[room].lost_identities[user.identity].tactic_name 
				&& room_data[room].lost_identities[user.identity].tactic_name == name) {
					var uid = room_data[room].lost_identities[user.identity].tactic_uid;
					db.collection('users').findOne({_id:user.identity, tactics:{$elemMatch:{uid:uid}}}, {'tactics.$':1}, function(err, result) { 					
						if (!err && result && result.tactics) {
							db.collection('users').update({_id:user.identity}, {$pull: {tactics:{uid:uid}}}, {upsert: true});
						} else {
							uid = newUid();
						}
						push_tactic_to_db(user, room, name, uid);
					});
			} else {
				var uid = newUid();
				push_tactic_to_db(user, room, name, uid);
			}
		}
	}
	
	function restore_tactic(user, uid, cb) {
		if (user.identity) {
			var query = {_id:user.identity};
			query['tactics.uid'] = uid;
			db.collection('users').findOne(query, {'tactics.$':1, _id:0}, function(err, header) {
				if (!err && header) {
					var id = header.tactics[0].uid;
					db.collection('stored_tactics').findOne({_id:id}, function(err2, result) {
						if (!err2 && result) {							
							var uid = newUid();
							room_data[uid] = result;
							room_data[uid].last_join = Date.now();
							room_data[uid].userlist = {};
							room_data[uid].lost_users = {};
							room_data[uid].lost_identities = {};
							room_data[uid].trackers = {};
							room_data[uid].lost_users[user.id] = "owner";
							if (user.identity) {
								room_data[uid].lost_identities[user.identity] = {role: "owner", tactic_name:header.tactics[0].name, tactic_uid:id};
							}
							room_data[uid].locked = true;
							cb(uid);
						} else {
							cb(newUid());
						}
					});
				} else {
					cb(newUid());
				}
			});
		} else {
			cb(newUid());
		}
	}
	
	function remove_tactic(identity, id) {
		db.collection('users').update({_id:identity}, {$pull: {tactics:{uid:id}}});
	}
	
	function rename_tactic(user, uid, new_name) {
		db.collection('users').findOne({_id:user.identity, tactics:{$elemMatch:{uid:uid}}},{'tactics.$':1}, function(err, result) {
			if (!err && result && result.tactics) {
				var tactic = result.tactics[0];
				db.collection('users').update({_id:user.identity}, {$pull: {tactics:{uid:uid}}});
				tactic.name = new_name;
				db.collection('users').update({_id:user.identity}, {$push: {tactics:tactic}});
			}			
		});
	}
	
	function create_anonymous_user(req) {
		if (!req.session.passport) {
			req.session.passport = {};
		}
		req.session.passport.user = {};
		req.session.passport.user.id = newUid();
		req.session.passport.user.name = "Anonymous";		
	}
	
	// initializing session middleware
	var Session = require('express-session');
	var RedisStore = require('connect-redis')(Session);
	var mwCache = Object.create(null);
	function virtualHostSession(req, res, next) {
		var host = req.hostname.split('.');
		if (host.length >= 2) {
			host = '.' + host[host.length-2] + '.' + host[host.length-1];
		} else {
			host = '.' + host[0];
		}		
		var hostSession = mwCache[host];
		if (!hostSession) {
			var store = new RedisStore(secrets.redis_options);
			hostSession = mwCache[host] = Session({secret: secrets.cookie, resave:true, saveUninitialized:false, cookie: {domain:host, expires: new Date(Date.now() + 30 * 86400 * 1000) }, store: store});
			mwCache[host].store = store;
		}
		hostSession(req, res, next);
	}
	
	app.use(function(req, res, next) {
		res.header('Access-Control-Allow-Credentials', true);
		res.header('Access-Control-Allow-Origin', req.headers.origin);
		res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
		res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
		next();
	});
	
	app.use(virtualHostSession);

	// Configuring Passport
	app.use(passport.initialize());
	app.use(passport.session());
	
	//create a default user + detect language
	app.use(function(req, res, next) { 
		var domain = req.headers.host;
		var subDomain = domain.split('.');	
		if (subDomain[0] == 'www') {
			res.redirect(301, 'http://' + subDomain.slice(1).join('.') + req.originalUrl);
			return;
		}
		if (!req.session.passport || !req.session.passport.user) {
			create_anonymous_user(req);		
		}
		
		if (subDomain.length > 2 && locales.indexOf(subDomain[0]) != -1) {
			req.session.locale = subDomain[0];
			subDomain = subDomain.slice(1);
		} else {
			if (req.query.lang) {
				req.session.locale = req.query.lang;
			} else if (!req.session.locale) {
				req.session.locale = "en";
			}
		}
		req.fullUrl = subDomain.join('.') + req.originalUrl;
		next();
	});
	
	
	OpenIDStrategy = require('passport-openid').Strategy;
	passport.use('openid', new OpenIDStrategy({
			returnURL: function(req) { 
				return "http://" + req.hostname + "/auth/openid/callback"; 
			},
			passReqToCallback: true,
			stateless: true
		},
		function(req, identifier, done) {
			var user = {};
			if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
				user.id = req.session.passport.user.id;
			} else {
				user.id = newUid();		
			}
			user.server = identifier.split('://')[1].split(".wargaming")[0];
			user.identity_provider = "wargaming";
			user.identity = identifier.split('/id/')[1].split("/")[0];
			user.wg_account_id = user.identity.split('-')[0];
			user.name = user.identity.split('-')[1];
			done(null, user);
		}
	));
	
	StrategyGoogle = require('passport-google-openidconnect').Strategy;
	passport.use('google', new StrategyGoogle({
		clientID: secrets.google.client_id,
		clientSecret: secrets.google.secret,
		callbackURL: '/auth/google/callback',
		passReqToCallback:true,
		stateless: true
	  },
	  function(req, iss, sub, profile, accessToken, refreshToken, done) {
		var user = {};
		if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
			user.id = req.session.passport.user.id;
		} else {
			user.id = newUid();
		}
		user.identity = profile.id;
		user.identity_provider = "google";
		user.name = profile.displayName;
		done(null, user);
	  }
	));	
	
	StrategyBnet = require('passport-bnet').Strategy;
	passport.use('battlenet', new StrategyBnet({
		clientID: secrets.battlenet.client_id,
		clientSecret: secrets.battlenet.secret,
		callbackURL:"https://karellodewijk.github.io/battlenet_redirect.html",
		passReqToCallback:true,
		stateless: true
	  },
	  function(req, accessToken, refreshToken, profile, done) {
		var user = {};
		if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
			user.id = req.session.passport.user.id;
		} else {
			user.id = newUid();
		}
		user.identity = 'bnet-'+profile.id;
		user.identity_provider = "bnet";
		user.name = profile.battletag;
		done(null, user);
	  }
	));	

	FacebookStrategy = require('passport-facebook').Strategy;
	passport.use('facebook', new FacebookStrategy({
		clientID: secrets.facebook.client_id,
		clientSecret: secrets.facebook.secret,
		callbackURL: "/auth/facebook/callback",
		passReqToCallback: true,
		stateless: true
	  },
	  function(req, accessToken, refreshToken, profile, done) {
		var user = {};
		if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
			user.id = req.session.passport.user.id;
		} else {
			user.id = newUid();
		}
		user.identity = profile.id;
		user.identity_provider = "facebook";
		user.name = profile.displayName;
		done(null, user);
	  }
	));

	TwitterStrategy = require('passport-twitter').Strategy;
	passport.use('twitter', new TwitterStrategy({
		consumerKey: secrets.twitter.client_id,
		consumerSecret: secrets.twitter.secret,
		callbackURL: "/auth/twitter/callback",
		passReqToCallback: true,
		stateless: true
	  },
	  function(req, token, tokenSecret, profile, done) {
		var user = {};
		if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
			user.id = req.session.passport.user.id;
		} else {
			user.id = newUid();
		}
		user.identity = profile.id;
		user.identity_provider = "twitter";
		user.name = profile.displayName;
		done(null, user);
	  }
	));	

	var SteamWebAPI = require('steam-web');
	var steam = new SteamWebAPI({ apiKey: secrets.steam.api_key, format: 'json' });
	passport.use('steam', new OpenIDStrategy({
			returnURL: function(req) { 
				return "http://wottactic.com/steam_redirect.html?dest=" + "http://" + req.hostname + "/auth/steam/callback/";
			},
			realm: function(req) { 
				return "http://wottactic.com"; 
			},
			provider: 'steam',
			name:'steam',
			profile:false,
			providerURL: 'http://steamcommunity.com/openid/id/',
			passReqToCallback: true,
			stateless: true
		},
		function(req, identifier, done) {
			var user = {};
			if (req.session.passport && req.session.passport.user && req.session.passport.user.id) {
				user.id = req.session.passport.user.id;
			} else {
				user.id = newUid();		
			}
			steam.getPlayerSummaries({
				steamids: [ identifier ],
				callback: function(err, result) {
					if (!err) {
						user.identity = result.response.players[0].steamid;
						user.identity_provider = "steam";
						user.name = result.response.players[0].personaname;
					}
					done(null, user);
				}
			});			
		}
	));

	passport.serializeUser(function(user, done) {
		if (user.wg_account_id) {
			db.collection('users').update({_id:user.identity}, {$set: { _id:user.identity, name:user.name, identity_provider:user.identity_provider, server:user.server, wg_id:user.wg_account_id}}, {upsert:true});
		} else {
			db.collection('users').update({_id:user.identity}, {$set: { _id:user.identity, name:user.name, identity_provider:user.identity_provider}}, {upsert:true});
		}
		done(null, user);
	});

	passport.deserializeUser(function(user, done) {
		done(null, user);
	});

	// session support for socket.io
	
	function session_from_sessionid_host(sessionId, host, cb) {
		if (sessionId && mwCache[host]) {
			mwCache[host].store.get(sessionId, function(err, data) {
				if (!err) {
					cb(data);
				} else {
					cb();
				}
			});
		} else {
			cb();
		}
		
	}
	
	io.use(function(socket, next) {
		// pretend we have the cookie
		var sessionId = socket.request._query.connect_sid;
		var host = socket.request._query.host;
		
		session_from_sessionid_host(sessionId, host, function(session) {
			if (session) {
				socket.request.session = session;
				next();
			} else {
				socket.request.hostname = socket.handshake.headers.host;
				virtualHostSession(socket.request, socket.request.res, next);					
			}
		});
	});
	
	// setup routes
	var router = express.Router();

	router.get('/', function(req, res, next) {
		if (req.hostname) {
			if (req.hostname.indexOf('awtactic') != -1) {
				req.session.game = "aw";
			} else if (req.hostname.indexOf('wowstactic') != -1) {
				req.session.game = "wows";
			} else {
				req.session.game = "wot";
			}
		} else {
			req.session.game = "wot";
		}
		res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	
	router.get('/wot.html', function(req, res, next) {
	  req.session.game = 'wot';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/aw.html', function(req, res, next) {
	  req.session.game = 'aw';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/wows.html', function(req, res, next) {
	  req.session.game = 'wows';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/blitz.html', function(req, res, next) {
	  req.session.game = 'blitz';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/lol', function(req, res, next) {
	  req.session.game = 'lol';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/hots', function(req, res, next) {
	  req.session.game = 'hots';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/sc2', function(req, res, next) {
	  req.session.game = 'sc2';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/health_check.html', function(req, res, next) {
	  res.sendStatus(200);
	});	
	function planner_redirect(req, res, game) {
	  if (req.query.restore) {
		var uid = newUid();
		restore_tactic(req.session.passport.user, req.query.restore, function (uid) {           
			save_room(uid, function() {
			  delete room_data[uid];
			  res.redirect(game+'planner.html?room='+uid);
			});
		});
	  } else if (!req.query.room) {
		  res.redirect(game+'planner.html?room='+newUid());
	  }	else {
		  res.cookie('room',req.query.room , { maxAge: 30 * 86400 * 1000 });
		  req.session.game = game;
		  res.render('planner', { game: req.session.game, 
								  user: req.session.passport.user,
								  locale: req.session.locale,
								  url: req.fullUrl,
								  sid: req.sessionID });
								  
		  if (req.session.passport.user.identity) {
			  setImmediate(function() {
				  var link = "http://" + req.fullUrl.split('/')[0] + "/" + req.session.game + 'planner.html?room=' + req.query.room;
				  db.collection('users').update(
				  	  { _id:req.session.passport.user.identity },
					  { "$pull": { "rooms": link } }
				  )
				  db.collection('users').update(
				  	  { _id:req.session.passport.user.identity },
					  { "$push": { "rooms": { "$each": [link], "$slice": -10 } } }
				  )
			  });
		  }					  
	  }
	}
	router.get('/wotplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'wot');
	});
	router.get('/awplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'aw');
	});
	router.get('/wowsplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'wows');
	});
	router.get('/blitzplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'blitz');
	});
	router.get('/lolplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'lol');
	});
	router.get('/hotsplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'hots');
	});
	router.get('/sc2planner.html', function(req, res, next) {
	  planner_redirect(req, res, 'sc2');
	});
	router.get('/about.html', function(req, res, next) {
	  if (!req.session.game) {
		  req.session.game = 'wot';
	  }
	  res.render('about', { game: req.session.game, 
							user: req.session.passport.user,
							locale: req.session.locale,
							url: req.fullUrl});
	});
	router.get('/getting_started.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  res.render('getting_started', { game: req.session.game, 
									  user: req.session.passport.user,
									  locale: req.session.locale,
									  url: req.fullUrl});
	});
	router.get('/privacypolicy.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  res.render('privacypolicy', { game: req.session.game, 
								    user: req.session.passport.user,
									locale: req.session.locale,
									url: req.fullUrl});
	});
	router.get('/older_news.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  res.render('older_news', { game: req.session.game, 
								 user: req.session.passport.user,
								 locale: req.session.locale,
								 url: req.fullUrl});
	});
	
	router.get('/stored_tactics.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  if (req.session.passport.user.identity) {
		get_tactics(req.session.passport.user.identity, req.session.game, function(tactics, last_rooms) {
		  res.render('stored_tactics', { game: req.session.game, 
										 user: req.session.passport.user,
										 locale: req.session.locale,
										 tactics: tactics,
										 rooms: last_rooms,
										 url: req.fullUrl,
										 sid: req.sessionID });
		});
	  } else {
		  res.redirect('/');
	  }
	});	
	router.post('/remove_tactic', function(req, res, next) {
		if (req.session.passport.user.identity) {
			remove_tactic(req.session.passport.user.identity, req.body.id);
		}
		return;
	});
	router.post('/rename_tactic', function(req, res, next) {
		if (req.session.passport.user.identity) {
			rename_tactic(req.session.passport.user, req.body.uid, req.body.new_name);
		}
		return;
	});
	router.get('/share_tactic.html', function(req, res, next) {
		if (req.session.passport.user.identity) {
			var uid = escaper.escape(decodeURIComponent(req.query.uid));
			var name = escaper.escape(decodeURIComponent(req.query.name));
			var game = escaper.escape(decodeURIComponent(req.query.game));
			
			db.collection('users').findOne({_id:req.session.passport.user.identity, tactics:{$elemMatch:{name:name}}}, {'tactics.$':1}, function(err, result) { 					
				if (!err && result && result.tactics) {
					res.send("Error: A tactic with name: " + name + " already exists.");
					return;
				} else {
					db.collection('users').update({_id:req.session.passport.user.identity}, {$push:{tactics:{name:name, date:Date.now(), game:game, uid:uid}}}, {upsert: true});
					res.redirect("stored_tactics.html");
				}
			});
		} else {
			res.send("First log in and try again");
			return;
		}
		return;
	});	
	app.get('/logout', function(req, res) {
	  var return_to = req.headers.referer;
	  req.logout();
	  res.redirect(return_to);
	});

	
	function copy_slides(source, target, res) {
		if (source.slides) {
			if (Object.keys(source.slides).length > 100) {
				res.send("Error: too many slides");
				return;
			}
			if (Object.keys(room_data[target].slides).length > 100) {
				res.send("Error: too many slides");
				return;
			}
			var largest_slide_order = -1;
			for (var key in room_data[target].slides) {
				if (room_data[target].slides.hasOwnProperty(key)) {
					if (room_data[target].slides[key].order > largest_slide_order) {
						largest_slide_order = room_data[target].slides[key].order;
					}
				}
			}
			largest_slide_order += 4294967296;
			for (var key in source.slides) {
				if (source.slides.hasOwnProperty(key)) {
					var uid = newUid();
					var new_slide = JSON.parse(JSON.stringify(source.slides[key]));
					new_slide.order += largest_slide_order;
					new_slide.uid = uid;
					room_data[target].slides[uid] = new_slide;
					io.to(target).emit('new_slide', new_slide);
				}
			}
			res.send("Success");
		}
	}
	
	router.post('/add_to_room', function(req, res, next) {
		var sessionId = req.body.session_id;
		var host = req.body.host;
		
		session_from_sessionid_host(sessionId, host, function(session) {			
			var target = req.body.target;
			var user = session.passport.user;
						
			if (!room_data[target]) {
				res.send("Error: room is not active or does not exist.");
				return;
			} else if (room_data[target].locked
					  && (!room_data[target].userlist[user.id] || !room_data[target].userlist[user.id].role) 
					  && (!room_data[target].lost_identities[user.identity] || !room_data[target].lost_identities[user.identity].role)) {
				res.send("Error: You don't have permission for that room.");
				return;
			}
			
			var source = req.body.source;
			if (req.body.stored == "true") {
				db.collection('stored_tactics').findOne({_id:source}, function(err, result) {
					if (!err && result) { 
						copy_slides(result, target, res);
					} else {
						res.send("Error: tactic not found");
					}
				});
			} else {
				db.collection('tactics').findOne({_id:source}, function(err, result) {
					if (!err && result) { 
						copy_slides(result, target, res);
					} else {
						res.send("Error: tactic not found");
					}
				});				
			}
		});
	});
	
	function save_return(req, res, next) {
		req.session.return_to = req.headers.referer;
		next();
	}
	function redirect_return(req, res, next) {
		res.redirect(req.session.return_to);
		delete req.session.return_to;
		return;
	}
	
	//openid
	router.post('/auth/openid', save_return, passport.authenticate('openid'));
	router.get('/auth/openid/callback', passport.authenticate('openid'), redirect_return);

	//google
	router.post('/auth/google', save_return, passport.authenticate('google'));
	router.get('/auth/google/callback', passport.authenticate('google'), redirect_return);

	//facebook
	router.post('/auth/facebook', save_return, passport.authenticate('facebook'));
	router.get('/auth/facebook/callback', passport.authenticate('facebook'), redirect_return);

	//twitter
	router.post('/auth/twitter', save_return, passport.authenticate('twitter'));
	router.get('/auth/twitter/callback', passport.authenticate('twitter'), redirect_return);

	//steam
	router.post('/auth/steam', save_return, passport.authenticate('steam'));
	router.get('/auth/steam/callback', passport.authenticate('steam'), redirect_return);

	//battle.net
	router.post('/auth/battlenet', save_return, passport.authenticate('battlenet'));
	router.get('/auth/battlenet/callback', passport.authenticate('battlenet'), redirect_return);

	//force saves all rooms to DB, run before a restart/shutdown
	router.get('/save', function(req, res, next) {
		if (req.query.pw == secrets.mongodb_password) {
			var unsaved_rooms = 0;
			for (var room in room_data) {
				unsaved_rooms++;
				save_room(room, function(){
					unsaved_rooms--;
				});
			}
			var timer = setInterval(function() {
				if (unsaved_rooms == 0) {
					clearInterval(timer);
					res.send('Success');
				}
			}, 500);			
		} else {
			res.send('Invalid password')
		}
	});

	app.get('/disconnect', function(req, res) {
		if (req.query.pw == secrets.mongodb_password) {
			for (var room in room_data) {
				save_room(room, function(){
					io.to(room).emit('reconnect');
				});
			}
			res.send('Success');
		} else {
			res.send('Invalid password')
		}
	});

	//some basic logging data
	router.get('/log', function(req, res, next) {
		res.send("Active rooms: " + Object.keys(room_data).length);
	});
	
	//reloads templates, so I don't have to restart the server to add basic content
	var lastmod = (new Date()).toISOString().substr(0,10);
	router.get('/refresh', function(req, res, next) {
		if (req.query.pw == secrets.mongodb_password) {
			var ejs = require('ejs')
			ejs.clearCache();
			lastmod = (new Date()).toISOString().substr(0,10);
			i18n.configure({
				locales: locales,
				directory: __dirname + "/locales",
				updateFiles: true
			});
			res.send('Success');
		} else {
			res.send('Invalid password')
		}
	});
	
	//////////////
	//clanportal//
	//////////////

	var cp = require(__dirname + "/clanportal.js");
	cp.load(router, http, secrets, db, escaper);

	//////////////////
	//end clanportal//
	//////////////////

	//generate a sitemap and robots.txt file
	var paths = [];
	for (var key in router.stack) {
		if (router.stack[key].route.stack[0].method == 'get') {
			paths.push(router.stack[key].route.path)
		}
	}

	paths.splice(paths.indexOf('/auth/twitter/callback'), 1);
	paths.splice(paths.indexOf('/auth/facebook/callback'), 1);
	paths.splice(paths.indexOf('/auth/google/callback'), 1);
	paths.splice(paths.indexOf('/auth/openid/callback'), 1);
	paths.splice(paths.indexOf('/auth/steam/callback'), 1);
	paths.splice(paths.indexOf('/save'), 1);
	paths.splice(paths.indexOf('/log'), 1);
	paths.splice(paths.indexOf('/refresh'), 1);
	paths.splice(paths.indexOf('/disconnect'), 1);
	paths.splice(paths.indexOf('/health_check.html'), 1);
	paths.splice(paths.indexOf('share_tactic.html'), 1);

	router.get('/sitemap.xml', function(req, res, next) {
		var sitemap = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">';
		var priority = 1;
		for (var i = 0; i < paths.length; ++i) {
			sitemap += "<url>";
			sitemap += "<loc>" + "http://" + req.headers.host + paths[i] + "</loc>";
			sitemap += "<lastmod>" + lastmod + "</lastmod>";
			sitemap += "<changefreq>daily</changefreq>"
			sitemap += "<priority>" + priority.toFixed(2) + "</priority>";
			for (var j = 0; j < locales.length; ++j) {
				sitemap += '<xhtml:link rel="alternate" hreflang="' + locales[j] + '" href="' + "http://" + locales[j] + '.' + req.fullUrl.split('/')[0] + paths[i] + '" />'
			}
			sitemap += "</url>";
			priority -= (0.5/paths.length);
		}
		sitemap += "</urlset>";
		res.header('Content-Type', 'application/xml');
		res.send(sitemap);
	});
	
	var robots_base = "User-agent: *\n";
	robots_base += "Disallow: /auth/twitter\n";
	robots_base += "Disallow: /auth/facebook\n";
	robots_base += "Disallow: /auth/google\n";
	robots_base += "Disallow: /auth/openid\n";
	
	router.get('/robots.txt', function(req, res, next) {
		res.header('Content-Type', 'text/plain');
		res.send(robots_base + "Sitemap: " + 'http://' + req.headers.host + "/sitemap.xml");
	});
	
	//add router to app
	app.use('/', router);		
	
	// catch 404 and forward to error handler
	app.use(function(req, res, next) {
		var err = new Error('Not Found: "' + req.path + '"');
		err.status = 404;
		return;
	});

	function join_room(socket, room) {
		room_data[room].last_join = Date.now();
		var user = socket.request.session.passport.user;

		if (user) {
			if (room_data[room].userlist[user.id]) {
				//a user is already connected to this room in probably another tab, just increase a counter
				room_data[room].userlist[user.id].count++;
			} else {
				room_data[room].userlist[user.id] = {name:user.name, id:user.id, role:user.role, identity:user.identity, logged_in:(user.identity) ? true : false};
				room_data[room].userlist[user.id].count = 1;
				if (room_data[room].lost_users[user.id]) {				
					//if a user was previously connected to this room and had a role, restore that role
					room_data[room].userlist[user.id].role = room_data[room].lost_users[user.id];
				} else if (user.identity && room_data[room].lost_identities[user.identity] && room_data[room].lost_identities[user.identity].role) {
					//if a user with given identity had a role, restore that role
					room_data[room].userlist[user.id].role = room_data[room].lost_identities[user.identity].role;
				}
				socket.broadcast.to(room).emit('add_user', room_data[room].userlist[user.id]);			
			}			
			socket.join(room);
			var tactic_name;
			if (room_data[room].lost_identities[user.identity] && room_data[room].lost_identities[user.identity].tactic_name) {
				tactic_name = room_data[room].lost_identities[user.identity].tactic_name;
			} else if (room_data[room].name) {
				tactic_name = room_data[room].name;
			} else {
				tactic_name = "";
			}
			
			socket.emit('room_data', room_data[room], user.id, tactic_name);
		}
	}
	
	//socket.io callbacks
	io.sockets.on('connection', function(socket) { 
		socket.on('join_room', function(room, game) {
			if (!socket.request.session.passport || !socket.request.session.passport.user) {
				create_anonymous_user(socket.request);
			}
			
			if (!(room in room_data)) {
				db.collection('tactics').findOne({_id:room}, function(err, result) {
					if (!err && result) {
						if (!(room in room_data)) { //it may have been created already
							room_data[room] = result;
							room_data[room].last_join = Date.now();	
							room_data[room].userlist = {};
							room_data[room].trackers = {};
						}
					} else {
						if (!(room in room_data)) { //it may have been created already
							room_data[room] = {};
							var slide0_uid = newUid();
							room_data[room].slides = {};
							room_data[room].slides[slide0_uid] = {name:'1', order:0, entities:{}, uid:slide0_uid, z_top:0}
							var background_uid = newUid();
							if (game == 'lol') {
								room_data[room].slides[slide0_uid].entities[background_uid] = {uid:background_uid, type:'background', path:"http://karellodewijk.github.io/maps/lol/rift.jpg", z_index:0, size_x: 15000, size_y: 15000};
								room_data[room].locked = false;
							} else {
								room_data[room].slides[slide0_uid].entities[background_uid] = {uid:background_uid, type:'background', path:"", z_index:0};
								room_data[room].locked = true;
							}
							room_data[room].active_slide = slide0_uid;
							room_data[room].trackers = {};
							room_data[room].userlist = {};
							room_data[room].lost_users = {};
							room_data[room].lost_identities = {};
							var user = socket.request.session.passport.user;
							room_data[room].lost_users[user.id] = "owner";
							if (user.identity) {
								room_data[room].lost_identities[user.identity] = {role: "owner"};
							}
							room_data[room].game = game;
						}
					}
					join_room(socket, room);
					return;
				});
			} else {
				join_room(socket, room);
				return;
			}
		});

		socket.onclose = function(reason) {
			//hijack the onclose event because otherwise we lose socket.rooms data
			var user = socket.request.session.passport.user;
			for (var room in socket.rooms) { //first room is clients own little private room so we start at 1			
				if (room_data[room] && room_data[room].userlist[user.id]) {
					if (room_data[room].userlist[user.id].count == 1) {
						socket.broadcast.to(room).emit('remove_user', user.id);
						delete room_data[room].userlist[user.id];
						for (var key in room_data[room].trackers) {
							if (room_data[room].trackers[key].owner == user.id) {
								delete room_data[room].trackers[key];
								break;
							}
						}
					} else {
						room_data[room].userlist[user.id].count--;
					}
				}	
				if (io.sockets.adapter.rooms[room].length <= 1) {	//we're the last one in the room and we're leaving
					clean_up_room(room);
				}
			}	
			Object.getPrototypeOf(this).onclose.call(this,reason); //call original onclose
		}
		
		//socket.on('error', function(e){
		//	console.log("error: ", e);
		//	console.trace();
		//});
		
		socket.on('create_entity', function(room, entity, slide) {
			if (room_data[room] && entity) {
				if (room_data[room].slides[slide]) {
					if (room_data[room].slides[slide].z_top !== 'undefined') {
						room_data[room].slides[slide].z_top++;
						entity.z_index = room_data[room].slides[slide].z_top;
					}
					room_data[room].slides[slide].entities[entity.uid] = entity;
					socket.broadcast.to(room).emit('create_entity', entity, slide, socket.request.session.passport.user.id);
				}
			}
		});
		
		socket.on('drag', function(room, uid, slide, x, y) {
			if (room_data[room] && room_data[room].slides[slide] && room_data[room].slides[slide].entities[uid]) {
				room_data[room].slides[slide].entities[uid].x = x;
				room_data[room].slides[slide].entities[uid].y = y;
				if (room_data[room].slides[slide].z_top !== 'undefined') {
					room_data[room].slides[slide].z_top++;
					room_data[room].slides[slide].entities[uid].z_index = room_data[room].slides[slide].z_top;
				}
				io.to(room).emit('drag', uid, slide, x, y, socket.request.session.passport.user.id);
			}
		});

		socket.on('ping_marker', function(room, x, y, color) {
			socket.broadcast.to(room).emit('ping_marker', x, y, color, socket.request.session.passport.user.id);
		});

		socket.on('show_grid', function(room, slide, bool) {
			room_data[room].slides[slide].show_grid = bool;
			socket.broadcast.to(room).emit('show_grid', slide, bool, socket.request.session.passport.user.id);
		});
		
		socket.on('track', function(room, tracker) {
			room_data[room].trackers[tracker.uid] = tracker;
			socket.broadcast.to(room).emit('track', tracker, socket.request.session.passport.user.id);
		});
		
		socket.on('track_move', function(room, uid, delta_x, delta_y) {
			if (room_data[room] && room_data[room].trackers[uid]) {
				room_data[room].trackers[uid].x += delta_x;
				room_data[room].trackers[uid].x += delta_y;
				socket.broadcast.to(room).emit('track_move', uid, delta_x, delta_y);
			}
		});
		
		socket.on('stop_track', function(room, uid) {
			delete room_data[room].trackers[uid];
			socket.broadcast.to(room).emit('stop_track', uid);
		});
		
		socket.on('remove', function(room, uid, slide) {
			if (room_data[room] && room_data[room].slides[slide] && room_data[room].slides[slide].entities[uid]) {
				delete room_data[room].slides[slide].entities[uid];
				socket.broadcast.to(room).emit('remove', uid, slide, socket.request.session.passport.user.id);
			}
		});

		socket.on('chat', function(room, message, color) {
			socket.broadcast.to(room).emit('chat', message, color);
		});
		
		socket.on('update_user', function(room, user) {
			if (room_data[room] && room_data[room].userlist) {
				room_data[room].userlist[user.id] = user;
				if (room_data[room].lost_users) {
					if (user.role) {
						room_data[room].lost_users[user.id] = user.role;
						if (user.identity) {
							if (!room_data[room].lost_identities[user.identity]) {
								room_data[room].lost_identities[user.identity] = {};
							}
							room_data[room].lost_identities[user.identity].role = user.role;
						}
					} else {
						if (room_data[room].lost_users[user.id]) {
							delete room_data[room].lost_users[user.id];
						}
						if (room_data[room].lost_identities[user.identity]) {
							room_data[room].lost_identities[user.identity].role = user.role;
						}
					}
				}				
				socket.broadcast.to(room).emit('add_user', user, socket.request.session.passport.user.id);
			}
		});


		//slide stuff, and why I don't store them in an array
		socket.on('change_slide', function(room, uid) {
			if (room_data[room]) {
				if (room_data[room].slides[uid]) {
					room_data[room].active_slide = uid;
					io.to(room).emit('change_slide', uid); 
				} else {
					io.to(room).emit('change_slide', room_data[room].active_slide, socket.request.session.passport.user.id); 
				}
			}
		});
		
		function find_previous_slide(room, upper_bound) {
			var largest = -9007199254740990;
			var uid = 0;
			for (var key in room_data[room].slides) {
				var order = room_data[room].slides[key].order
				if ( order < upper_bound && order > largest) {
					largest = order;
					uid = key;
				}
			}
			return uid;
		}

		function find_next_slide(room, lower_bound) {
			var smallest = 9007199254740991;
			var uid = 0;
			for (var key in room_data[room].slides) {
				var order = room_data[room].slides[key].order
				if ( order > lower_bound && order < smallest) {
					smallest = order;
					uid = key;
				}
			}
			return uid;
		}
		
		function hash(uid) {
			var hash = 0;
			for (var i = 0; i < uid.length; i++) {
				hash += uid.charCodeAt(i);
			}
			return hash;
		}
		
		//if 2 players add a slide at the same position (same .order) concurrently 
		//then we look at a hash of their uid, if the hash of the new slide is lower
		//we assign it a lower order (put if before the slide we know about). If it is 
		//higher we assign it a higher order. 
		//Clients basically resolve this the same way. The result will be that the revised
		//order numbers will be the same regardless of the order in which slide data arrived
		function resolve_order_conflicts(room, slide, max_recursions) {
			if (max_recursions == 0) return; //we give up, let this tactic burn, save the server
			for (var key in room_data[room].slides) {
				if (room_data[room].slides[key].order == slide.order) {
					var new_order;
					if (hash(slide.uid) < hash(key)) {
						var prev_slide = find_previous_slide(room, slide.order);
						var last_order = 0;
						if (prev_slide != 0) {
							last_order = room_data[room].slides[prev_slide].order;
						}
						slide.order = Math.floor((slide.order - last_order) / 2);
					} else {
						var next_slide = find_next_slide(room, slide.order);
						var next_order = slide.order + 4294967296;
						if (next_slide != 0) {
							next_order = room_data[room].slides[next_slide].order;
						}					
						slide.order = Math.floor((next_order - slide.order) / 2);						
					}
					
					resolve_order_conflicts(room, slide, max_recursions-1); //we do this again because it might still not be unique
					return;
				}
			}
		}
		
		socket.on('new_slide', function(room, slide) {
			if (room_data[room]) {
				resolve_order_conflicts(room, slide, 5);
				room_data[room].slides[slide.uid] = slide;
				room_data[room].active_slide = slide.uid;
				socket.broadcast.to(room).emit('new_slide', slide);
				io.to(room).emit('change_slide', slide.uid, socket.request.session.passport.user.id);
			}
		});

		socket.on('remove_slide', function(room, uid) {			
			if (room_data[room]) {
				if (Object.keys(room_data[room].slides).length > 1) {
					if (uid == room_data[room].active_slide) {
						var order = room_data[room].slides[uid].order;
						var new_slide = find_previous_slide(room, order);
						if (new_slide == 0) {
							new_slide = find_next_slide(room, order);
						}
						room_data[room].active_slide = new_slide;
					}
					delete room_data[room].slides[uid];
					socket.broadcast.to(room).emit('remove_slide', uid, socket.request.session.passport.user.id);
					
					io.to(room).emit('change_slide', room_data[room].active_slide);
				}
			}
		});
		
		socket.on('rename_slide', function(room, uid, name) {
			if (room_data[room] && room_data[room].slides[uid]) {
				room_data[room].slides[uid].name = name;
				socket.broadcast.to(room).emit('rename_slide', uid, name, socket.request.session.passport.user.id);
			}
		});	
		
		socket.on('change_slide_order', function(room, uid, order) {
			if (room_data[room] && room_data[room].slides[uid]) {
				room_data[room].slides[uid].order = order;
				socket.broadcast.to(room).emit('change_slide_order', uid, order, socket.request.session.passport.user.id);
			}
		});

		socket.on('lock_room', function(room, is_locked) {
			if (room_data[room]) {
				room_data[room].locked = is_locked;
				socket.broadcast.to(room).emit('lock_room', is_locked, socket.request.session.passport.user.id);
			}
		});

		socket.on('store', function(room, name) {
			var user = socket.request.session.passport.user;			
			store_tactic(user, room, name);
		});

		socket.on('save_room', function(room, name) {
			save_room(room, function(){});
		});		
		


		
	});
	
	//create server
	var server = http.createServer(app);	
	io.attach(server);
	server.listen(secrets.port);	
	
	});
	
});


