const express = require('express');
const axios = require('axios');
const admin = require('./firebase/admin'); // O admin que corrigimos antes

const app = express();

// OBRIGATÓRIO: O Webhook da OpenPix envia JSON. Precisamos desse middleware.
app.use(express.json());

const OPENPIX_API_URL = 'https://api.openpix.com.br/v1';

// ==========================================
// ROTA 1: CRIAR COBRANÇA PIX (Chamada pelo FlutterFlow)
// ==========================================
app.post('/api/checkout', async (req, res) => {
  const { userId, valueInCents } = req.body; // Recebe o ID do usuário e o valor da assinatura

  if (!userId) {
    return res.status(400).json({ error: 'O userId é obrigatório.' });
  }

  try {
    // Geramos um ID único para essa transação no formato: UID_timestamp
    const correlationID = `${userId}_${Date.now()}`;

    // Requisição para a OpenPix criar a cobrança
    const response = await axios.post(
      `${OPENPIX_API_URL}/charge`,
      {
        correlationID: correlationID,
        value: valueInCents || 2990, // Ex: R$ 29,90 se não enviado
        comment: 'Assinatura Premium MedWise',
      },
      {
        headers: {
          'Authorization': process.env.OPENPIX_APP_ID,
          'Content-Type': 'application/json',
        },
      }
    );

    // A OpenPix retorna o "brCode" (Copia e Cola) e a "paymentLinkUrl" (Página com QR Code)
    const { brCode, paymentLinkUrl } = response.data.charge;

    return res.json({
      success: true,
      pixCopiaCola: brCode,
      linkPagamento: paymentLinkUrl,
    });

  } catch (error) {
    console.error('Erro ao gerar Pix:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Erro interno ao gerar cobrança Pix.' });
  }
});

// ==========================================
// ROTA 2: WEBHOOK (A OpenPix avisa aqui quando for pago)
// ==========================================
app.post('/api/webhook/openpix', async (req, res) => {
  const payload = req.body;

  // IMPORTANTE: Responda rápido à OpenPix para eles saberem que você recebeu o aviso
  res.status(200).send('Webhook recebido');

  try {
    // 1. Verifica se o evento é de um Pix pago/concluído
    if (payload.event === 'OPENPIX:CHARGE_COMPLETED') {
      const charge = payload.pix.charge;
      const correlationID = charge.correlationID;

      // 2. Extrai o userId que guardamos lá no correlationID (tudo antes do '_')
      const userId = correlationID.split('_')[0];

      console.log(`Pagamento confirmado para o usuário: ${userId}`);

      // 3. Atualiza o status do usuário diretamente no Firestore do Firebase
      const db = admin.firestore();
      
      await db.collection('users').doc(userId).update({
        isPremium: true,
        premiumUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 dias de acesso
        updatedAt: new Date(),
      });

      console.log(`Usuário ${userId} atualizado para Premium com sucesso!`);
    }
  } catch (error) {
    console.error('Erro ao processar Webhook:', error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});