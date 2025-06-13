const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async () => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Pro Plan - SecureAPI' },
        unit_amount: 900,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: 'https://secureapi.online/success',
    cancel_url: 'https://secureapi.online/cancel',
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ url: session.url }),
  };
};
