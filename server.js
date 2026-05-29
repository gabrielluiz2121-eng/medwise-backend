const express = require('express')

const app = express()

app.use(express.json())

app.get('/', (req, res) => {
  res.send('MedWise API Online 🚀')
})

app.listen(3000, () => {
  console.log('Servidor rodando')
})