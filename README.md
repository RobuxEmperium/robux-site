# UltimateBloxx - Demo Clone (Node + Express)

**Aviso:** Este projeto é uma implementação demo com funcionalidades básicas: cadastro/login, carrinho, geração de código PIX por pedido (texto + QR gerado no cliente), painel admin para marcar pagamento/entrega, e chat simples por pedido (Socket.IO).
Não conecta a APIs reais de Pix — os códigos são strings identificadoras que o admin deve validar manualmente.

## Como usar
1. Instale dependências:
   ```bash
   npm install
   ```
2. Inicialize o banco (é automático na primeira execução) e rode:
   ```bash
   npm start
   ```
3. Abra `http://localhost:3000`

## Contas pre-criadas
- Vendedor/admin: email `seller@store.test`, senha `sellerpass`
- Comprador: `buyer@store.test`, senha `buyerpass`

## Onde configurar envio de e-mail (opcional)
Configure variáveis no `config.json` com as credenciais SMTP.

## Observações
- Projeto para deploy simples em VPS/Heroku. Configure variáveis de ambiente e HTTPS em produção.
- Se quiser integração real com Pix, trocaremos a geração por chamadas à API de PSP (ex: Gerencianet, Pagar.me, etc.).
