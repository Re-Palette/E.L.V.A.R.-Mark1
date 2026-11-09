// Where Supabase Auth sends the browser after Google sign-in, an e-mail confirmation or a password-reset link: /auth/callback/?code=... (or ?error=...).
// The app itself finishes the exchange (it holds the PKCE verifier), so this page only hands the result over to the main page and removes it from the history.
(function () {
  var q = location.search || '', h = location.hash || '';
  location.replace('/' + q + h);
})();
