const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('./firebase/admin'); // O inicializador seguro que criamos

const app = express();

// PERMISSÕES: Permite que seu Web App do FlutterFlow acesse essa API sem bloqueios de CORS
app.use(cors({ origin: true }));
app.use(express.json());

const WOOVI_API_URL = 'https://api.openpix.com.br/v1';

// ==========================================
// ROTA 1: GERAR COBRANÇA PIX (Chamada pelo FlutterFlow Web)
// ==========================================
app.post('/api/checkout', async (req, res) => {
  const { userId, valueInCents } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'O campo userId é obrigatório.' });
  }

  try {
    // correlationID serve para rastrear o pagamento. Vinculamos o UID do usuário + timestamp
    const correlationID = `${userId}_${Date.now()}`;

    // Payload de acordo com a documentação oficial da Woovi (/v1/charge)
    const data = {
      correlationID: correlationID,
      value: valueInCents || 2990, // R$ 29,90 padrão se não enviado
      comment: 'Assinatura Premium MedWise'
    };

    const response = await axios.post(`${WOOVI_API_URL}/charge`, data, {
      headers: {
        'Authorization': process.env.OPENPIX_APP_ID, // Sua API Key configurada no Railway
        'Content-Type': 'application/json'
      }
    });

    // Retorna os dados exatos que o FlutterFlow precisa para exibir o QR Code na tela
    return res.json({
      success: true,
      correlationID: correlationID,
      pixCopiaCola: response.data.charge.brCode,
      qrcodeImagem: response.data.charge.qrCodeImage,
      linkPagamento: response.data.charge.paymentLinkUrl
    });

  } catch (error) {
    console.error('Erro Woovi API:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Falha ao gerar cobrança Pix.' });
  }
});

// ==========================================
// ROTA 2: WEBHOOK (A Woovi avisa aqui quando o médico/estudante pagar)
// ==========================================
app.post('/api/webhook/openpix', async (req, res) => {
  // 1. Responde imediatamente com 200 OK para a Woovi validar a rota com sucesso
  res.status(200).send('OK');

  const payload = req.body;

  try {
    // 2. Filtra se o evento recebido é de uma cobrança paga com sucesso
    if (payload.event === 'OPENPIX:CHARGE_COMPLETED') {
      const correlationID = payload.pix.charge.correlationID;
      
      // Recupera o ID do usuário original que guardamos antes do "_"
      const userId = correlationID.split('_')[0];

      console.log(`[Woovi] Pagamento aprovado para o usuário: ${userId}`);

      // 3. Atualiza o Firestore usando o Firebase Admin
      const db = admin.firestore();
      await db.collection('users').doc(userId).update({
        isPremium: true,
        premiumUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Libera por 30 dias
        updatedAt: new Date()
      });

      console.log(`[Firestore] Status Premium ativado com sucesso para ${userId}`);
    }
  } catch (error) {
    console.error('Erro ao processar o webhook da Woovi:', error.message);
  }
});

// Inicialização do servidor configurada para o ambiente do Railway (0.0.0.0)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor MedWise ativo na porta ${PORT}`);
});