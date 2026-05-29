const admin = require('firebase-admin');

let serviceAccount;

// 1. Verifica se estamos no Railway (usando a variável de ambiente)
if (process.env.FIREBASE_CREDENTIALS) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  } catch (error) {
    console.error("Erro ao ler a variável FIREBASE_CREDENTIALS:", error);
  }
} else {
  // 2. Se não houver a variável (no seu computador local), ele busca o arquivo físico
  // Dica: Se o seu arquivo local terminar com .json.json, ajuste o nome abaixo
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (error) {
    // Caso o arquivo local tenha a extensão duplicada .json.json
    try {
      serviceAccount = require('./serviceAccountKey.json.json');
    } catch (e) {
      console.error("Arquivo de credenciais local não encontrado.");
    }
  }
}

// Inicializa o Firebase apenas se encontrou as credenciais
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  console.error("Não foi possível inicializar o Firebase Admin: Credenciais ausentes.");
}

module.exports = admin;