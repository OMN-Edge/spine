// Opens Paddle's checkout for the transaction the app made (the address carries `?_ptxn=`, which Paddle.js reads and opens by itself).
// This page is served from an origin of its own, apart from the app's, so Paddle's script never runs where a person's records are open.
(function () {
  var c = window.SPINE_CHECKOUT || {};
  var status = document.getElementById('status');
  if (!c.token || !window.Paddle) {
    status.textContent = 'The payment page is not set up. Go back to the app and try again later.';
    return;
  }
  if (c.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
  window.Paddle.Initialize({
    token: c.token,
    checkout: { settings: { displayMode: 'overlay', successUrl: c.returnUrl } },
    eventCallback: function (event) {
      if (event.name === 'checkout.closed') {
        status.textContent = 'The payment was not completed.';
        if (c.returnUrl) window.location.assign(c.returnUrl);
      }
    },
  });
  if (!/[?&]_ptxn=/.test(window.location.search)) status.textContent = 'There is nothing to pay here. Choose a plan in the app.';
})();
