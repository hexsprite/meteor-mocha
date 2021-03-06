Package.describe({
  name: 'dispatch:mocha',
  summary: 'Run Meteor package or app tests with Mocha',
  git: 'https://github.com/DispatchMe/meteor-mocha.git',
  version: '0.4.1',
  testOnly: true,
});

Package.onUse(function onUse(api) {
  api.use([
    'practicalmeteor:mocha-core@1.0.0',
    'ecmascript@0.3.0',
  ]);

  api.use([
    'aldeed:browser-tests@0.1.0'
  ], 'server');

  api.mainModule('client.js', 'client');
  api.mainModule('server.js', 'server');
});
