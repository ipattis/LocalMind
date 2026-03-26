// ── ThinkHere — Auth Redirect ──
// Auth is handled entirely by app.thinkhere.ai's custom login UI.
// This file just wires the landing page buttons to navigate there.

const APP_URL = "https://app.thinkhere.ai";

window.signIn = function () {
  window.location.href = APP_URL;
};

window.signUp = function () {
  window.location.href = APP_URL;
};

window.signOut = function () {
  sessionStorage.removeItem("thinkhere_tokens");
  window.location.reload();
};
