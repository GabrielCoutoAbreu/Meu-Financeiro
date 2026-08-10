# Arquitetura e decisões do MVP

## 1. Objetivo

Entregar uma versão utilizável em iPhone e Windows 11 para controle financeiro com lançamentos manuais, sem depender de servidor ou lojas de aplicativos. A solução adotada é uma Progressive Web App responsiva.

## 2. Camadas

### Interface

HTML, CSS e JavaScript sem frameworks externos. O layout alterna entre barra lateral em telas grandes e navegação inferior em telas móveis.

### Estado e regras financeiras

O arquivo `app/app.js` contém:

- modelos de contas, cartões, transações, orçamentos e objetivos;
- cálculo de saldo por conta;
- consolidação de ganhos e gastos;
- tratamento de transferências sem alterar o patrimônio total;
- visão por caixa e competência;
- geração de parcelas e recorrências;
- cálculo de orçamento e progresso de metas;
- geração de relatórios e arquivos.

### Persistência

Os dados são serializados em JSON e armazenados em `localStorage`. Há exportação e restauração de backup para reduzir risco de perda.

### Offline e instalação

O `service worker` mantém em cache os arquivos da interface. O manifesto permite instalação como PWA. No Windows, um servidor local em PowerShell abre a aplicação em modo `--app` do Microsoft Edge.

## 3. Modelo simplificado

- Conta: nome, tipo, instituição e saldo inicial.
- Cartão: nome, bandeira, limite, fechamento, vencimento e conta vinculada.
- Transação: tipo, valor, datas, situação, conta/cartão, categoria, membro, tags, parcelas e recorrência.
- Orçamento: categoria, mês, limite e percentual de alerta.
- Objetivo: nome, valor-alvo, valor acumulado, prazo e observações.

## 4. Regras relevantes

- Transferências reduzem uma conta e aumentam outra, sem virar receita ou despesa.
- Compras no cartão entram nos relatórios de consumo, mas não reduzem diretamente o saldo bancário.
- Transações ignoradas não entram nos cálculos.
- Transações pendentes aparecem nas listas, mas os indicadores principais usam apenas confirmadas.
- Na visão por caixa, a aplicação usa data de pagamento, depois vencimento e, por último, data da operação.
- Na visão por competência, usa a data da operação.

## 5. Evolução recomendada

### Versão 1.1

- faturas completas por ciclo de fechamento;
- pagamento de fatura sem duplicidade;
- anexos e comprovantes;
- categorias personalizadas administráveis;
- alertas do sistema;
- importação de CSV bancário.

### Versão 2

- backend com API;
- autenticação e recuperação de conta;
- banco de dados criptografado;
- sincronização entre dispositivos;
- trilha de auditoria;
- multiusuário familiar;
- aplicativo nativo empacotado para App Store e Microsoft Store.

## 6. Segurança para produção

Antes de uso comercial, implementar e auditar:

- HTTPS obrigatório;
- criptografia em trânsito e em repouso;
- autenticação forte e expiração de sessão;
- isolamento por usuário;
- backups e recuperação;
- logs sem exposição de dados sensíveis;
- gestão de consentimentos;
- exclusão e portabilidade de dados;
- política de privacidade e adequação à LGPD;
- testes de segurança, carga, regressão e migração.
