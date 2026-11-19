module.exports = {
  default: {
    require: ['step-definitions/**/*.ts'],
    requireModule: ['ts-node/register'],
    paths: ['features/**/*.feature'],
    format: [
      'progress-bar',
      'html:outputs/cucumber-report.html',
      'json:outputs/cucumber-report.json',
    ],
    formatOptions: { snippetInterface: 'async-await' },
  },
};
