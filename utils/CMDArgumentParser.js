var cmdArgumentParser = {};

cmdArgumentParser.parseArguments = () => {
  var secretsFilePath = "";
  var constants = require("./constants");
  process.argv.slice(2).forEach((val, index) => {
    var argument = val.split("=");
    if (argument[0] === constants.EnvironmentArgument) {
      secretsFilePath = parseEnvironment(argument[1]);
    }
  });
  return { "secretsPath": secretsFilePath };
};

parseEnvironment = (argument) => {
  var constants = require("./constants");
  switch (argument) {

    case constants.DevEnvironment:
      return "./secrets.dev.txt";

    case constants.LocalEnvironment:
      return "./secrets.txt";
  }
};

module.exports = cmdArgumentParser;