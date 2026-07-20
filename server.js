const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==========================================
// 1. INICIALIZAÇÃO DO FIREBASE ADMIN
// ==========================================
let db;
try {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("A variável FIREBASE_SERVICE_ACCOUNT está vazia ou não existe no Railway.");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("✅ Firebase Admin inicializado com sucesso!");
  }
} catch (error) {
  console.error("🚨 ERRO CRÍTICO no Firebase Admin:", error.message);
}

// ==========================================
// 2. MOTOR DE NOTIFICAÇÕES (PUSH)
// ==========================================
async function enviarPush(userId, titulo, mensagem) {
  try {
    // 1. Acessa a subcoleção fcm_tokens do usuário
    const tokensSnapshot = await admin.firestore()
      .collection('user')
      .doc(userId)
      .collection('fcm_tokens')
      .get();

    // 2. Extrai os tokens de cada documento da subcoleção
    const tokens = tokensSnapshot.docs.map(doc => doc.data().fcm_token);

    // 3. Verifica se encontramos algum token
    if (tokens.length === 0) {
      console.log(`[Push Abortado] Usuário ${userId} não possui tokens registrados na subcoleção.`);
      return;
    }

    // 4. Montar o pacote da notificação
    const payload = {
      notification: {
        title: titulo,
        body: mensagem,
      },
      tokens: tokens, // Envia para todos os aparelhos do usuário encontrados
    };

    // 5. Disparar via Firebase Cloud Messaging usando o método atualizado
    const response = await admin.messaging().sendEachForMulticast(payload);
    console.log(`📲 Notificação Push enviada com sucesso para ${response.successCount} dispositivo(s) do usuário ${userId}.`);
    
  } catch (error) {
    console.error('🚨 Erro crítico ao buscar tokens ou enviar Push:', error);
  }
}

const app = express();
app.use(cors());

// ==========================================
// 3. HEALTH CHECK (TESTE NO NAVEGADOR)
// ==========================================
app.get('/', (req, res) => {
  res.status(200).send('🚀 Servidor da API do MedWise está online e operacional!');
});

// ==========================================
// 4. WEBHOOK DO STRIPE (Requer express.raw)
// ==========================================
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Erro Webhook Stripe] Falha: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (!db) return res.status(500).json([{ error: "erro_banco_dados" }]);

  // 4.1 SUCESSO: ASSINATURA CRIADA
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const subscriptionId = subscription.id;
    const userId = subscription.metadata ? subscription.metadata.userId : null;
    const customerId = subscription.customer;
    const statusStripe = subscription.status; 

    let planType = "MENSAL";
    if (subscription.plan) {
      if (subscription.plan.nickname) {
        planType = subscription.plan.nickname.toUpperCase();
      } else if (subscription.plan.interval === 'year') {
        planType = "ANUAL";
      }
    }

    const valor = subscription.plan ? subscription.plan.amount / 100 : 0;
    const moeda = subscription.plan ? subscription.plan.currency : 'brl';

    try {
      let updateUser = Promise.resolve();
      if (userId) {
        updateUser = db.collection('user').doc(userId).set({
          planoAtivo: planType,
          statusAssinatura: statusStripe === 'active' ? 'ativa' : statusStripe,
          gateway: 'stripe',
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      const createAssinatura = db.collection('assinaturas').doc(subscriptionId).set({
        userId: userId,
        plano: planType,
        status: statusStripe === 'active' ? 'ativa' : statusStripe,
        gateway: 'stripe',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const pagamentoId = `pay_stripe_${subscriptionId}_${Date.now()}`;
      const createPagamento = db.collection('pagamentos').doc(pagamentoId).set({
        userId: userId,
        plano: planType,
        valor: valor,
        moeda: moeda,
        statusPagamento: 'succeeded',
        gateway: 'stripe',
        dataPagamento: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await Promise.all([updateUser, createAssinatura, createPagamento]);
      console.log(`✅ [Stripe] Assinatura criada para UID ${userId}`);
      
      // ===== DISPARO DO PUSH NOTIFICATION =====
      if (userId) {
        await enviarPush(userId, "Assinatura Confirmada! 🎉", "Bem-vindo ao MedWise Premium. Todos os recursos foram liberados.");
      }

    } catch (error) {
      console.error(`[Erro Firebase Stripe Created]:`, error.message);
    }
  }
  // 4.2 ATUALIZAÇÃO: TROCA DE PLANO OU STATUS
  else if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const subscriptionId = subscription.id; 
    const userId = subscription.metadata ? subscription.metadata.userId : null;
    const statusStripe = subscription.status;

    let planType = "MENSAL";
    if (subscription.plan) {
      if (subscription.plan.nickname) {
        planType = subscription.plan.nickname.toUpperCase();
      } else if (subscription.plan.interval === 'year') {
        planType = "ANUAL";
      }
    }

    try {
      const updateAssinatura = db.collection('assinaturas').doc(subscriptionId).update({
        plano: planType,
        status: statusStripe === 'active' ? 'ativa' : statusStripe,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      let updateUser = Promise.resolve();
      if (userId) {
        updateUser = db.collection('user').doc(userId).update({
          planoAtivo: planType,
          statusAssinatura: statusStripe === 'active' ? 'ativa' : statusStripe,
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await Promise.all([updateAssinatura, updateUser]);
      console.log(`🔄 [Stripe] Assinatura atualizada: ${subscriptionId} | Novo plano: ${planType}`);

    } catch (error) {
      console.error('[Erro Atualizacao Firestore Stripe]:', error.message);
    }
  }
  // 4.3 FALHA/CANCELAMENTO: ASSINATURA DELETADA
  else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const subscriptionId = subscription.id; 

    try {
      await db.collection('assinaturas').doc(subscriptionId).update({
        status: 'cancelada',
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`❌ [Stripe] Assinatura cancelada na coleção 'assinaturas': ${subscriptionId}`);

      const userId = subscription.metadata ? subscription.metadata.userId : null;
      if (userId) {
        await db.collection('user').doc(userId).update({
          statusAssinatura: 'cancelada',
          planoAtivo: 'gratuito',
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`❌ [Stripe] Usuário ${userId} rebaixado para o plano gratuito.`);
        
        // Opcional: Avisar o usuário do cancelamento
        await enviarPush(userId, "Assinatura Cancelada", "Seu plano premium expirou e os recursos avançados foram bloqueados.");
      }

    } catch (error) {
      console.error('[Erro Cancelamento Firestore Stripe]:', error.message);
    }
  }

  res.status(200).json([{ received: true }]);
});

// ==========================================
// 5. MIDDLEWARES PARA AS DEMAIS ROTAS
// ==========================================
app.use(express.json());
// ==========================================
// ROTA DE INTELIGÊNCIA ARTIFICIAL (Responses API Stateful)
// ==========================================
app.post('/api/assistente', async (req, res) => {
  const { userId, mensagem } = req.body;
  const assistantId = process.env.OPENAI_ASSISTANT_ID;

  if (!userId || !mensagem) {
    return res.status(400).json(["O userId e a mensagem são obrigatórios."]);
  }

  try {
    const userDocRef = db.collection('user').doc(userId);
    const userDoc = await userDocRef.get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Correção: O parâmetro correto na nova arquitetura é apenas 'assistant'
    const requestOptions = {
      model: "gpt-4o",
      assistant: assistantId, 
      input: [
        { role: "user", content: mensagem }
      ]
    };

    if (userData.openai_previous_response_id) {
      requestOptions.previous_response_id = userData.openai_previous_response_id;
    }

    const response = await openai.responses.create(requestOptions);

    await userDocRef.set({
      openai_previous_response_id: response.id
    }, { merge: true });

    let textoResposta = response.output[0].content[0].text;

    // Higienização: Remove as marcações geradas pela IA do meio do texto
    textoResposta = textoResposta.replace(/【.*?】/g, '');

    // Retorno rigoroso em lista de string para agrupar os resultados
    return res.status(200).json([textoResposta]);

  } catch (error) {
    console.error('[Erro OpenAI Responses API]:', error);
    return res.status(500).json(["Erro interno de comunicação com o assistente médico."]);
  }
});
// ==========================================
// 6. ROTAS DE CRIAÇÃO (CHECKOUT)
// ==========================================

// 6.1 STRIPE EMBEDDED
app.post('/api/checkout-stripe-embedded', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body;
  let priceId = planType.toLowerCase() === 'anual' ? process.env.STRIPE_PRICE_ANUAL : process.env.STRIPE_PRICE_MENSAL;

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `medwise://medwise2.com/Home`,
      metadata: { userId, planType: planType.toUpperCase() },
      subscription_data: {
        metadata: {
          userId: userId
        }
      },
    });
    
    return res.json([{
      client_secret: session.client_secret
    }]);

  } catch (error) {
    return res.status(500).json([{ error: "erro_criacao_sessao" }]);
  }
});

// 6.2 WOOVI (PIX AUTOMÁTICO - COBRANÇA IMEDIATA)
app.post('/api/checkout-woovi', async (req, res) => {
  const { userId, planType = 'mensal', userCpf, userName } = req.body;
  const value = planType.toLowerCase() === 'anual' ? 19990 : 1990; 
  const frequencia = planType.toLowerCase() === 'anual' ? 'ANNUALLY' : 'MONTHLY';

  try {
    const cpfLimpo = userCpf.replace(/\D/g, '');

    let diaAtual = new Date().getDate();
    if (diaAtual > 28) diaAtual = 28;

    const payloadImediato = {
      name: "Assinatura MedWise",
      value: value,
      customer: { 
        name: userName, 
        taxID: cpfLimpo,
        email: "contato@medwise.app.br",
        phone: "5511999999999",
        address: {
          zipcode: "04556300",
          street: "rua de são paulo",
          number: "3432",
          neighborhood: "BROOKLIN PAULISTA",
          city: "SAO PAULO",
          state: "SP",
          complement: "CONJ 26"
        }
      },
      correlationID: `sub_${userId}_${Date.now()}`,
      comment: "Assinatura",
      frequency: frequencia,
      type: "PIX_RECURRING",
      pixRecurringOptions: { 
        journey: "PAYMENT_ON_APPROVAL",
        retryPolicy: "NON_PERMITED" 
      },
      dayGenerateCharge: diaAtual,
      dayDue: 3,
      metadata: { 
        userId: userId, 
        planType: planType.toUpperCase() 
      }
    };

    const response = await fetch('https://api.woovi.com/api/v1/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': process.env.WOOVI_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadImediato)
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('[Woovi API Error]:', JSON.stringify(data));
      throw new Error(data.error || "Falha ao comunicar com a Woovi");
    }

    return res.json([ data.subscription.pixRecurring.emv ]); 

  } catch (error) {
    console.error('[Erro Woovi Checkout]:', error.message);
    return res.status(500).json([{ error: "erro_criacao_woovi" }]);
  }
});

// ==========================================
// 7. WEBHOOK DA WOOVI (COM ATUALIZAÇÃO COMPLETA NO FIREBASE)
// ==========================================
app.post('/api/webhook/woovi', async (req, res) => {
  try {
    const webhookData = req.body;
    const evento = webhookData.event;
    const correlationID = webhookData.correlationID;

    if (correlationID && correlationID.startsWith('sub_')) {
      const partes = correlationID.split('_');
      const userId = partes[1]; 
      
      const planType = "MENSAL"; 
      
      const valorWoovi = webhookData.value ? webhookData.value / 100 : 0;

      if (evento === 'PIX_AUTOMATIC_APPROVED' || evento === 'PIX_AUTOMATIC_COBR_COMPLETED') {
        console.log(`✅ [ACESSO LIBERADO] Usuário: ${userId} | Woovi`);
        
        const updateUser = db.collection('user').doc(userId).set({ 
          statusAssinatura: 'ativa',
          planoAtivo: planType,
          gateway: 'woovi',
          wooviSubscriptionId: correlationID, 
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const createAssinatura = db.collection('assinaturas').doc(correlationID).set({
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          gateway: "woovi",
          plano: planType,
          status: "ativa",
          wooviCorrelationId: correlationID,
          userId: userId 
        }, { merge: true });

        const pagamentoId = webhookData.globalID || `pay_woovi_${Date.now()}`;
        const createPagamento = db.collection('pagamentos').doc(pagamentoId).set({
          userId: userId,
          plano: planType,
          valor: valorWoovi,
          moeda: 'brl',
          statusPagamento: evento === 'PIX_AUTOMATIC_COBR_COMPLETED' ? 'paid' : 'approved',
          gateway: 'woovi',
          dataPagamento: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await Promise.all([updateUser, createAssinatura, createPagamento]);
        
        // ===== DISPARO DO PUSH NOTIFICATION =====
        if (userId) {
          await enviarPush(userId, "Pagamento Confirmado! 🎉", "Bem-vindo ao MedWise Premium. Todos os recursos foram liberados.");
        }

      } else if (evento === 'PIX_AUTOMATIC_REJECTED' || evento === 'PIX_AUTOMATIC_CANCELED' || evento === 'PIX_AUTOMATIC_COBR_REJECTED') {
        console.log(`❌ [ACESSO BLOQUEADO] Usuário: ${userId} | Woovi`);
        
        const cancelAssinatura = db.collection('assinaturas').doc(correlationID).set({
          status: "cancelada_ou_falha",
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        const cancelUser = db.collection('user').doc(userId).update({ 
          statusAssinatura: 'cancelada',
          planoAtivo: 'gratuito',
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });

        await Promise.all([cancelAssinatura, cancelUser]);
      }
    } else {
      console.log(`⚠️ Webhook da Woovi recebido sem correlationID válido.`);
    }

    return res.status(200).send('Webhook processado');
  } catch (error) {
    console.error('[Erro no Webhook Woovi]:', error.message);
    return res.status(500).send('Erro interno');
  }
});

// ==========================================
// 8. ORQUESTRADOR: GERENCIAMENTO E CANCELAMENTO
// ==========================================

// 8.1 Rota Unificada de Portal
app.post('/api/gerenciar-assinatura', async (req, res) => {
  const { userId } = req.body;

  try {
    const userDoc = await db.collection('user').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json([{ error: "erro_usuario_nao_encontrado" }]);
    
    const userData = userDoc.data();

    if (userData.gateway === 'stripe') {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: userData.stripeCustomerId,
        return_url: 'medwise://home', 
      });
      return res.json([{ url: portalSession.url }]);
    } 
    
    if (userData.gateway === 'woovi') {
      return res.json([{ status: "gateway_woovi" }]); 
    }

    return res.status(400).json([{ error: "erro_sem_assinatura" }]);
  } catch (error) {
    return res.status(500).json([{ error: "erro_gerar_portal" }]);
  }
});

// 8.2 Rota Unificada de Cancelamento
app.post('/api/cancelar-assinatura', async (req, res) => {
  const { userId } = req.body;

  try {
    const userDoc = await db.collection('user').doc(userId).get();
    const userData = userDoc.data();

    if (userData.gateway === 'stripe' && userData.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(userData.stripeSubscriptionId);
    } 
    else if (userData.gateway === 'woovi' && userData.wooviSubscriptionId) {
      const response = await fetch(`https://api.woovi.com/api/v1/subscriptions/${userData.wooviSubscriptionId}/cancel`, {
        method: 'PUT',
        headers: { 'Authorization': process.env.WOOVI_APP_ID }
      });
      if (!response.ok) throw new Error("Falha na Woovi");
    }

    await db.collection('user').doc(userId).update({
      statusAssinatura: 'cancelada',
      planoAtivo: 'gratuito'
    });

    return res.json([{ status: "cancelamento_efetuado" }]);

  } catch (error) {
    console.error('[Erro Cancelamento]:', error.message);
    return res.status(500).json([{ error: "erro_ao_cancelar" }]);
  }
});

// ==========================================
// 9. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});