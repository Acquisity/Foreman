// Disposable CI probe for ENG-13398. Never merge: this file exists only to prove
// the validate workflow turns a pull request red on a lint error.
var probe = 1;
export const ciRedCheckProbe = probe;
