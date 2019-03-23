var redis = require('redis');
const fs = require('fs');
var secrets = JSON.parse(fs.readFileSync('secrets.txt', 'utf8'));

module.exports = {
  buildClient: (redisOptions) => {
    var secrets = JSON.parse(fs.readFileSync('secrets.txt', 'utf8'));
    var redisClient = redis.createClient(redisOptions);
    return redisClient;
  },
  authenticateRedis: (redisClient, redisOptions) => {
    redisClient.auth(redisOptions.pass, (e) => {
      if (e) {
        console.error(e);
        return;
      }
    });
  }
};