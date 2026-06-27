const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// Inicializa Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

// ─── WEBHOOK DO MERCADO PAGO ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type !== 'payment') return res.sendStatus(200);

    const paymentId = data?.id;
    if (!paymentId) return res.sendStatus(400);

    const mpResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    const payment = await mpResponse.json();
    if (payment.status !== 'approved') return res.sendStatus(200);

    const userId = payment.metadata?.user_id;
    const plan = payment.metadata?.plan;
    if (!userId) return res.sendStatus(400);

    const now = new Date();
    const renewalDate = new Date(now);
    if (plan === 'yearly') {
      renewalDate.setFullYear(renewalDate.getFullYear() + 1);
    } else {
      renewalDate.setMonth(renewalDate.getMonth() + 1);
    }

    await db.collection('users').doc(userId).set({
      isPremium: true,
      plan: plan,
      renewalDate: Timestamp.fromDate(renewalDate),
      activatedAt: Timestamp.fromDate(now),
    }, { merge: true });

    console.log(`Premium ativado para usuário ${userId} — plano ${plan}`);
    return res.sendStatus(200);

  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.sendStatus(500);
  }
});

// ─── PAGAMENTO COM CARTÃO ─────────────────────────────────────────────────────
app.post('/create-card-payment', async (req, res) => {
  try {
    const { token, issuer_id, payment_method_id, transaction_amount, installments, payer, metadata } = req.body;

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `card-${metadata?.user_id}-${Date.now()}`,
      },
      body: JSON.stringify({
        token,
        issuer_id,
        payment_method_id,
        transaction_amount,
        installments,
        payer,
        metadata,
      }),
    });

    const payment = await response.json();

    if (payment.status === 'approved') {
      const { Timestamp } = require('firebase-admin/firestore');
      const userId = metadata?.user_id;
      const plan = metadata?.plan;

      if (userId) {
        const now = new Date();
        const renewalDate = new Date(now);
        if (plan === 'yearly') {
          renewalDate.setFullYear(renewalDate.getFullYear() + 1);
        } else {
          renewalDate.setMonth(renewalDate.getMonth() + 1);
        }

        await db.collection('users').doc(userId).set({
          isPremium: true,
          plan,
          renewalDate: Timestamp.fromDate(renewalDate),
          activatedAt: Timestamp.fromDate(now),
        }, { merge: true });
      }
    }

    return res.json({ status: payment.status, id: payment.id });

  } catch (error) {
    console.error('Erro pagamento cartão:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── GERAR PIX ───────────────────────────────────────────────────────────────
app.post('/create-pix', async (req, res) => {
  try {
    const { userId, plan, email } = req.body;
    console.log('Gerando PIX para:', { userId, plan, email }); // <-- adiciona

    const amount = plan === 'yearly' ? 179.90 : 19.90;
    const description = plan === 'yearly' ? 'FluxTV Premium Anual' : 'FluxTV Premium Mensal';

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${userId}-${plan}-${Date.now()}`,
      },
      body: JSON.stringify({
  transaction_amount: amount,
  description: description,
  payment_method_id: 'pix',
  payer: { email: email },
  metadata: { user_id: userId, plan: plan },
  notification_url: 'https://fluxtv-backend-production.up.railway.app/webhook', // <-- adiciona
}),
    });

    const payment = await response.json();
    console.log('Resposta MP:', JSON.stringify(payment)); // <-- adiciona

    if (!payment.point_of_interaction) {
      return res.status(400).json({ error: 'Erro ao gerar PIX', details: payment });
    }

    return res.json({
      paymentId: payment.id,
      qrCode: payment.point_of_interaction.transaction_data.qr_code,
      qrCodeBase64: payment.point_of_interaction.transaction_data.qr_code_base64,
      amount: amount,
    });

  } catch (error) {
    console.error('Erro ao criar PIX:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── VERIFICAR STATUS DO PAGAMENTO ───────────────────────────────────────────
app.get('/payment-status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    const payment = await response.json();
    return res.json({ status: payment.status });

  } catch (error) {
    return res.status(500).json({ error: 'Erro ao verificar pagamento' });
  }
});

// ─── CRIAR PREFERENCE (Desktop) ───────────────────────────────────────────────
app.post('/create-preference', async (req, res) => {
  try {
    const { userId, plan, email } = req.body;

    const amount = plan === 'yearly' ? 179.90 : 19.90;
    const title = plan === 'yearly' ? 'FluxTV Premium Anual' : 'FluxTV Premium Mensal';

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ title, quantity: 1, unit_price: amount, currency_id: 'BRL' }],
        payer: { email },
        metadata: { user_id: userId, plan },
        back_urls: {
          success: 'https://fluxtv-player.web.app/premium-success',
          failure: 'https://fluxtv-player.web.app/premium-failure',
          pending: 'https://fluxtv-player.web.app/premium-pending',
        },
        auto_return: 'approved',
      }),
    });

    const preference = await response.json();
    return res.json({ checkoutUrl: preference.init_point });

  } catch (error) {
    console.error('Erro ao criar preference:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FluxTV backend rodando na porta ${PORT}`));