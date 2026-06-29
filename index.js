const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const dotenv = require('dotenv');
const cron = require('node-cron');
const { Resend } = require('resend');

dotenv.config();

const app = express();
app.use(express.json());

// Inicializa Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendExpirationWarning(email, name, renewalDate) {
  const date = renewalDate.toDate ? renewalDate.toDate() : new Date(renewalDate);
  const formatted = `${date.getDate().toString().padStart(2,'0')}/${(date.getMonth()+1).toString().padStart(2,'0')}/${date.getFullYear()}`;
  
  await resend.emails.send({
    from: 'FluxTV <onboarding@resend.dev>',
    to: email,
    subject: 'Seu plano FluxTV Premium expira em breve',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background: #0D0D14; color: white; padding: 32px; border-radius: 12px;">
        <h1 style="color: #6C63FF;">FluxTV Premium</h1>
        <p>Olá${name ? ' ' + name : ''},</p>
        <p>Seu plano <strong>FluxTV Premium</strong> expira em <strong>${formatted}</strong>.</p>
        <p>Para continuar aproveitando todos os benefícios premium, renove seu plano:</p>
        <a href="https://fluxtv-player.web.app" 
           style="display: inline-block; background: #6C63FF; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
          Renovar Premium
        </a>
        <p style="color: #ffffff88; font-size: 13px;">Se você já renovou, ignore este email.</p>
        <hr style="border-color: #ffffff22; margin: 24px 0;">
        <p style="color: #ffffff44; font-size: 12px;">FluxTV — fluxiptv@outlook.com.br</p>
      </div>
    `,
  });
}

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

    const auth = getAuth();
    const userRecord = await auth.getUser(userId);

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
      email: userRecord.email,
      name: userRecord.displayName || '',
      renewalDate: Timestamp.fromDate(renewalDate),
      activatedAt: Timestamp.fromDate(now),
      warningSent: false,
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
      body: JSON.stringify({ token, issuer_id, payment_method_id, transaction_amount, installments, payer, metadata }),
    });

    const payment = await response.json();

    if (payment.status === 'approved') {
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

        const auth = getAuth();
        const userRecord = await auth.getUser(userId);

        await db.collection('users').doc(userId).set({
          isPremium: true,
          plan,
          email: userRecord.email,
          name: userRecord.displayName || '',
          renewalDate: Timestamp.fromDate(renewalDate),
          activatedAt: Timestamp.fromDate(now),
          warningSent: false,
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
        notification_url: 'https://fluxtv-backend-production.up.railway.app/webhook',
      }),
    });

    const payment = await response.json();

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
        notification_url: 'https://fluxtv-backend-production.up.railway.app/webhook',
      }),
    });

    const preference = await response.json();
    return res.json({ checkoutUrl: preference.init_point });

  } catch (error) {
    console.error('Erro ao criar preference:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── CRON JOB ─────────────────────────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  console.log('Verificando assinaturas...');
  try {
    const now = new Date();
    const in3Days = new Date(now);
    in3Days.setDate(in3Days.getDate() + 3);

    // ─── Desativa premium expirado ───────────────────────────────────────
    const expiredSnapshot = await db.collection('users')
      .where('isPremium', '==', true)
      .where('renewalDate', '<=', Timestamp.fromDate(now))
      .get();

    const batch = db.batch();
    expiredSnapshot.forEach(doc => {
      batch.update(doc.ref, { isPremium: false });
      console.log(`Premium expirado para usuário ${doc.id}`);
    });
    await batch.commit();
    console.log(`${expiredSnapshot.size} assinatura(s) expirada(s).`);

    // ─── Avisa quem expira em 3 dias ─────────────────────────────────────
    const warningSnapshot = await db.collection('users')
      .where('isPremium', '==', true)
      .where('renewalDate', '<=', Timestamp.fromDate(in3Days))
      .where('renewalDate', '>', Timestamp.fromDate(now))
      .get();

    for (const doc of warningSnapshot.docs) {
      const data = doc.data();
      if (data.email && !data.warningSent) {
        try {
          await sendExpirationWarning(data.email, data.name, data.renewalDate);
          await doc.ref.update({ warningSent: true });
          console.log(`Email de aviso enviado para ${data.email}`);
        } catch (e) {
          console.error(`Erro ao enviar email para ${data.email}:`, e.message);
        }
      }
    }

    // ─── Desativa trial expirado ──────────────────────────────────────────
    const trialSnapshot = await db.collection('users')
      .where('isOnTrial', '==', true)
      .get();

    const trialBatch = db.batch(); // <-- novo batch separado
    let trialExpired = 0;
    for (const doc of trialSnapshot.docs) {
      const data = doc.data();
      if (data.trialStartDate) {
        const trialEnd = data.trialStartDate.toDate();
        trialEnd.setDate(trialEnd.getDate() + 7);
        if (now > trialEnd) {
          trialBatch.update(doc.ref, { isOnTrial: false });
          trialExpired++;
          console.log(`Trial expirado para usuário ${doc.id}`);
        }
      }
    }
    await trialBatch.commit();
    console.log(`${trialExpired} trial(s) expirado(s).`);

  } catch (error) {
    console.error('Erro no cron job:', error);
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FluxTV backend rodando na porta ${PORT}`));