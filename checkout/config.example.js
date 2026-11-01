// Copy to config.js on the checkout origin and fill in. The token is Paddle's CLIENT-SIDE token (it can only open a checkout), never the API key.
window.SPINE_CHECKOUT = {
  token: 'live_xxxxxxxxxxxxxxxxxxxxxxxxxxx',
  environment: 'production', // or 'sandbox'
  returnUrl: 'https://spine.example.com/account',
};
