var redis = require('redis');
const fs = require('fs');

module.exports = {
  buildClient: (redisOptions) => {
    var secrets = JSON.parse(fs.readFileSync('secrets.json', 'utf8'));
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