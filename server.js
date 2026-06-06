const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// ==========================================
// 1. INICIALIZAÇÃO DO FIREBASE ADMIN
// ==========================================
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado com sucesso!");
  } catch (error) {
    console.error("Erro ao inicializar Firebase Admin. Verifique a variável FIREBASE_SERVICE_ACCOUNT.", error.message);
  }
}
const db = admin.firestore();

const app = express();

// Permite requisições do seu app/web
app.use(cors());

// ==========================================
// 2. WEBHOOK DO STRIPE (MUITO IMPORTANTE: DEVE VIR ANTES DO EXPRESS.JSON)
// ==========================================
// A Stripe exige o corpo cru (raw) da requisição para validar a assinatura de segurança
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Valida se a requisição realmente veio da Stripe
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Erro Webhook] Falha na assinatura: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Se o pagamento da assinatura foi concluído com sucesso
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Resgata os metadados que enviamos na hora de criar o checkout
    const userId = session.metadata.userId;
    const planType = session.metadata.planType; 

    try {
      // Atualiza o documento do usuário direto no banco de dados
      await db.collection('users').doc(userId).update({
        planoAtivo: planType,
        statusAssinatura: 'ativa',
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[Sucesso] Usuário ${userId} atualizado no banco para o plano ${planType}`);
    } catch (error) {
      console.error(`[Erro Firebase] Falha ao atualizar UID ${userId}:`, error.message);
    }
  }

  // Retorna 200 para a Stripe não tentar reenviar o evento
  res.status(200).json({ received: true });
});


// ==========================================
// 3. MIDDLEWARES GERAIS
// ==========================================
// A partir daqui, as rotas recebem JSON formatado normalmente
app.use(express.json());


// ==========================================
// 4. ROTA DE CRIAÇÃO DO CHECKOUT
// ==========================================
app.post('/api/checkout-stripe-embedded', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body;

  console.log(`[Stripe Embedded] Criando intenção [${planType.toUpperCase()}] para o UID: ${userId}`);

  let priceId = process.env.STRIPE_PRICE_MENSAL;
  if (planType.toLowerCase() === 'anual') {
    priceId = process.env.STRIPE_PRICE_ANUAL;
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY || !priceId) {
      return res.status(500).json(["Configurações do Stripe ausentes."]);
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page', // Correção da nomenclatura atual da Stripe
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      return_url: `https://checkout.medwise.app.br/retorno?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        userId: userId,
        planType: planType.toUpperCase()
      },
    });

    console.log(`[Stripe Embedded] Sessão criada! Secret: ${session.client_secret.substring(0, 10)}...`);

    // Retornando em formato de lista para manter a consistência de agrupamento no FlutterFlow
    return res.json([{
      success: true,
      client_secret: session.client_secret
    }]);

  } catch (error) {
    console.error('[Erro no Stripe Embedded]:', error.message);
    return res.status(500).json(["Erro ao criar sessão embedded no Stripe"]);
  }
});


// ==========================================
// 5. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});