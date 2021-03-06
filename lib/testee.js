var _ = require('lodash');
var miner = require('miner');
var launchpad = require('launchpad');
var debug = require('debug')('testee:main');

var utils = require('./utils');
var Reporter = require('./reporter');
var Runner = require('./runner');
var server = require('./server');
var getOptions = require('./defaults');

function Testee(options) {
  this.options = getOptions(options);
}

function createServer(options) {
  return new Promise(function (resolve, reject) {
    var app = server.create(options);
    var httpServer = app.listen(options.port);

    httpServer.once('listening', function () {
      resolve(httpServer);
    });

    httpServer.once('error', reject);
  });
}

_.extend(Testee.prototype, {
  bootstrap: function () {
    debug('bootstrapping Testee');
    // `bootstrap` can only be called when we want to do command line reporting
    // and browser launching
    if (!this.options.reporter) {
      return Promise.reject(new Error('No reporter set. Maybe you want to run only the server?'));
    }

    var self = this;
    // We need to initialize the reporter first (in case of errors)
    var reporter = new Reporter(this.options.reporter, this.options.coverage, this.options.root, this.options.reporterOptions);
    // A deferred that runs the initialization flow
    var flow = this.startServer()
      // Sets up the reporter and binds Feathers service events to it
      .then(function setupReporter() {
        // Bind Feathers service .lookup
        var lookup = self.api.service.bind(self.api);
        debug('hooking up services to Mocha reporter');
        reporter.setup(lookup('runs'), lookup('suites'), lookup('tests'), lookup('coverages'), lookup('logs'));

        self.reporter = reporter;
      })
      // Sets up the localhost tunneling service
      .then(self.setupTunnel.bind(self))
      // Sets up the Browser launching environment
      .then(self.setupLauncher.bind(self))
      // Initialize the runner (that actually runs tests on each browser)
      .then(function setupRunner() {
        debug('setting up test runner');
        self.runner = new Runner(_.extend({
          timeout: self.options.timeout,
          delay: self.options.delay,
          runs: self.api.service('runs')
        }, _.pick(self, 'tunnel', 'launcher')));
      })
      // Track bootstrap errors using the reporter
      .catch(function (error) {
        debug('bootstrapping failed. Reporting error', error);
        reporter.error(error);
        return self.shutdown().then(function () {
          return error;
        });
      })
      .then(function () {
        return self;
      });

    return flow;
  },

  startServer: function () {
    debug('starting testee server with options:', JSON.stringify(this.options, null, '\t'));
    return createServer(this.options).then(function (server) {
      debug('testee server started and listening on port ' + this.options.port);
      this.server = server;
      this.api = server.api;
    }.bind(this));
  },

  setupTunnel: function () {
    var tunnelOptions = this.options.tunnel;
    var type = tunnelOptions.type;

    if (!miner[type]) {
      return Promise.reject(new Error('Localhost tunnel ' + type + ' not supported.'));
    }

    debug('starting up localhost tunnel', tunnelOptions);
    var self = this;
    return new Promise(function (resolve, reject) {
      miner[type](_.omit(tunnelOptions, 'type'), function (error, url, process) {
        if (error) {
          return reject(error);
        }

        debug('localhost tunnel started on', url);

        var tunnel = self.tunnel = {
          url: url,
          process: process,
          makeUrl: function (path, params) {
            return utils.makeUrl(url, path, params);
          }
        };

        resolve(tunnel);
      });
    });
  },

  setupLauncher: function () {
    var launcherOptions = this.options.launch;
    var type = launcherOptions.type;

    if (!launchpad[type]) {
      return Promise.reject(new Error('Launchpad launcher ' + type + ' not supported.'));
    }

    debug('using browser launcher', type, launcherOptions);
    return new Promise(function (resolve, reject) {
      launchpad[type](_.omit(launcherOptions, 'type'), function (error, launcher) {
        if (error) {
          return reject(error);
        }
        resolve(launcher);
      });
    }).then(function (launcher) {
      debug('browser launcher initialized');
      this.launcher = launcher;
    }.bind(this));
  },

  test: function (files, browsers) {
    var self = this;
    var shutdown = self.shutdown.bind(self);

    return this.runner.test(files, browsers).catch(function (results) {
      var errors = 0;
      var failures = 0;

      results.forEach(function (current) {
        if (current instanceof Error) {
          self.reporter.error(current);
          errors++;
        } else {
          failures += current.failed;
        }
      });
      throw new Error('There were ' + errors + ' general errors and ' + failures + ' total test failures.');
    }).then(function (value) {
      return shutdown().then(function () {
        return value;
      });
    }, function (reason) {
      return shutdown().then(function () {
        throw reason;
      });
    });
  },

  shutdown: function () {
    if (this.reporter) {
      debug('shutting down reporter');
      this.reporter.end();
    }

    if (this.tunnel && this.tunnel.process) {
      debug('killing tunelling process');
      this.tunnel.process.kill();
    }

    if (this.server) {
      debug('closing server');
      this.server.destroy();
    }

    return Promise.resolve();
  }
});

exports.Manager = Testee;

exports.server = function (options) {
  return new Testee(options).bootstrap();
};

exports.test = function (files, browsers, options) {
  debug('running test for', files, browsers, options);
  var environment = new Testee(options);

  if (typeof files === 'string') {
    files = [files];
  }
  if (typeof browsers === 'string') {
    browsers = [browsers];
  }

  return utils.ensureFiles(files).then(function () {
    return environment.bootstrap().then(function () {
      debug('server bootstrapped, running tests.');
      return environment.test(files, browsers);
    });
  });
};
