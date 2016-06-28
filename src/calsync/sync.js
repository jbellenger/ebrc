const process = require('process');

require('./lib')
  .sync()
  .then(() => {
    console.log('sync success');
  })
  .catch((err) => {
    console.log('err', err);
    process.exit(1);
  });
