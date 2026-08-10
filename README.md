# Meu Financeiro

Aplicativo de controle financeiro pessoal com **lançamentos 100% manuais**, instalável como **PWA no iPhone** e executável em modo de aplicativo no **Windows 11**.

## Recursos entregues

- painel mensal com patrimônio, ganhos, gastos e resultado;
- instalação nova sem dados fictícios, pronta para cadastro manual;
- contas manuais e cálculo de saldo;
- cartões de crédito, fatura mensal e limite disponível;
- ganhos, gastos, transferências e compras no cartão;
- transações à vista, parceladas e recorrentes;
- situação confirmada, pendente ou ignorada;
- visão por caixa e por competência;
- categorias, subcategorias, membros e tags;
- orçamentos mensais com alertas de consumo;
- objetivos financeiros e cálculo de aporte mensal;
- relatórios por categoria e evolução de seis meses;
- exportação CSV;
- backup e restauração em JSON;
- funcionamento offline após a primeira abertura;
- tema claro e escuro.

## Abrir no Windows 11

1. Extraia toda a pasta do projeto.
2. Abra a pasta `windows`.
3. Dê dois cliques em `Start-MeuFinanceiro.cmd`.
4. O aplicativo será aberto em uma janela do Microsoft Edge, sem barra de endereço.
5. Para criar um atalho na área de trabalho, execute `Instalar-Atalho.cmd`.

Os dados ficam no perfil do navegador do Windows. Não mova apenas a pasta `windows`; ela depende da pasta `app` ao lado.

## Instalar no iPhone

O iPhone exige que o aplicativo seja publicado em um endereço **HTTPS**. A pasta `app` é um site estático e pode ser publicada em GitHub Pages, Netlify, Cloudflare Pages, Vercel ou servidor próprio.

Depois da publicação:

1. Abra o endereço no **Safari** do iPhone.
2. Toque em **Compartilhar**.
3. Escolha **Adicionar à Tela de Início**.
4. Confirme em **Adicionar**.

O ícone aparecerá como um aplicativo e funcionará em tela cheia. Após a primeira abertura, os arquivos essenciais ficam disponíveis offline.

## Testar localmente em outro sistema

Na raiz do projeto, execute um servidor HTTP apontando para a pasta `app`. Exemplos:

```bash
python -m http.server 8765 --directory app
```

ou:

```bash
npx serve app
```

Depois acesse `http://localhost:8765`.

## Publicar gratuitamente no GitHub Pages

1. Crie um repositório no GitHub.
2. Envie todo o conteúdo desta pasta.
3. Em **Settings > Pages**, selecione a publicação por GitHub Actions.
4. O workflow incluído em `.github/workflows/deploy-pages.yml` publicará a pasta `app`.

## Privacidade

Esta versão é local-first: não cria conta, não transmite movimentações e não possui servidor próprio. Os dados permanecem no armazenamento local do navegador. Use a opção **Baixar cópia JSON** regularmente.

O armazenamento local não substitui criptografia de banco de dados nem controles corporativos. Para uso comercial ou com dados financeiros sensíveis, recomenda-se acrescentar autenticação, criptografia em repouso, backend seguro, auditoria, política de privacidade e revisão LGPD.

## Limitações desta versão

- não há sincronização automática entre iPhone e PC;
- não há publicação na App Store;
- notificações são exibidas dentro do aplicativo, não como push do sistema;
- o cálculo de fatura usa as compras do mês selecionado, sem motor completo de ciclos de fechamento.

A sincronização entre dispositivos exigiria uma infraestrutura de servidor. A publicação nativa na App Store exige conta Apple Developer e assinatura do aplicativo em macOS.

## Estrutura

- `app/`: aplicação PWA completa;
- `windows/`: inicializador para Windows 11;
- `docs/`: arquitetura, escopo e próximos passos;
- `.github/workflows/`: publicação automática no GitHub Pages.
