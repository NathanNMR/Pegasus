# Pegasus — Mensageiro

**Pegasus** é um mensageiro em tempo real com interface Liquid Glass, identidade visual azul inspirada em uma galáxia e a constelação de Pegasus.

> **Status:** protótipo. Ainda não é recomendado para informações sensíveis e **não possui criptografia de ponta a ponta**. PG1 é uma transformação matemática personalizada, não criptografia moderna.

**Deploy:** Render (Docker) + Aiven (PostgreSQL). Passo a passo em [DEPLOY.md](DEPLOY.md).

---

## Stack

- Node.js 22.13+ (HTTP nativo, sem framework)
- **PostgreSQL** via [`pg`](https://node-postgres.com/) (Aiven, Neon, Supabase, local…)
- HTML, CSS e JavaScript nativos no front-end
- SSE (Server-Sent Events) para tempo real
- scrypt para hash de senhas
- AES-256-GCM para dados cifrados em repouso
- PG1 para transformação matemática do texto
- Docker + Render para hospedagem

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim | URI do PostgreSQL, ex.: `postgres://user:senha@host:porta/defaultdb` |
| `PEGASUS_MESSAGE_KEY` | Em produção | 64 caracteres hex. Gere com `openssl rand -hex 32`. **Guarde uma cópia**: sem ela as mensagens existentes ficam ilegíveis |
| `PG_CA_CERT` | Recomendada | Conteúdo do `ca.pem` do provedor (Aiven). Habilita a validação completa do certificado. Sem ela, a conexão é cifrada mas o certificado não é verificado |
| `PEGASUS_TRUST_PROXY` | Atrás de proxy | `1` no Render. Sem isso o limite de tentativas de login vale para todos os usuários juntos |
| `NODE_ENV` | — | `production` ativa cookie `Secure` e exige a chave de mensagens (já definido no Dockerfile) |
| `HOST` | — | Padrão `127.0.0.1`; o Dockerfile usa `0.0.0.0` |
| `PORT` | — | Padrão `3000`; o Render define sozinho |
| `PEGASUS_DATA_DIR` | — | Pasta da chave local de desenvolvimento (não usada em produção) |
| `PG_POOL_MAX` | — | Máximo de conexões no pool (padrão `10`) |

### Sobre o SSL do banco

O `server.mjs` remove o parâmetro `sslmode` da `DATABASE_URL` e decide o SSL por conta própria:

| Situação | Comportamento |
|---|---|
| `PG_CA_CERT` definido | SSL com validação completa da CA (**recomendado**) |
| Host remoto sem `PG_CA_CERT` | SSL ativo, certificado não validado (aviso no log) |
| `localhost` sem `sslmode` | Sem SSL |
| `?sslmode=disable` | Sem SSL |

## Rodando localmente

Requisitos: Node.js 22.13+ e um PostgreSQL acessível.

```bash
npm install
export DATABASE_URL=postgres://usuario:senha@localhost:5432/pegasus
npm start            # http://localhost:3000
npm run dev          # com reinício automático
```

Em desenvolvimento (sem `NODE_ENV=production`) a chave de mensagens é gerada em `data/local-secret.key`. **Não apague esse arquivo** se já houver mensagens gravadas.

Para subir um PostgreSQL local rapidamente:

```bash
docker run -d --name pegasus-db -e POSTGRES_PASSWORD=pegasus -e POSTGRES_DB=pegasus -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:pegasus@localhost:5432/pegasus
```

As tabelas são criadas e migradas automaticamente na inicialização (`CREATE TABLE IF NOT EXISTS`).

## Deploy resumido (Render + Aiven)

1. No Aiven, crie um serviço **PostgreSQL** e copie a **Service URI** e o **CA certificate**.
2. No Render, crie um **Web Service** a partir deste repositório (runtime **Docker**) ou use o `render.yaml` como Blueprint.
3. Configure `DATABASE_URL`, `PG_CA_CERT`, `PEGASUS_MESSAGE_KEY` e `PEGASUS_TRUST_PROXY=1`.
4. Defina o *Health Check Path* como `/api/health`.

Detalhes, solução de problemas e alternativas em [DEPLOY.md](DEPLOY.md).

## Estrutura do projeto

```
.
├── Dockerfile            # imagem de produção (npm ci + node server.mjs)
├── render.yaml           # Blueprint do Render
├── server.mjs            # servidor HTTP, API, SSE e acesso ao PostgreSQL
├── package.json
├── public/               # front-end (HTML, CSS, JS, imagens)
├── deploy/               # exemplos para VM própria (env, systemd, Caddy, backup)
├── tests/                # testes
├── DEPLOY.md
└── README.md
```

## Funcionalidades

- Cadastro e login por e-mail e senha; código de contato único de seis caracteres.
- Conversas privadas e **grupos** (até 50 participantes, com administradores).
- Mensagens de texto, imagens, GIFs, áudio, voz, documentos e cartões de contato.
- Responder, reagir, favoritar, fixar, encaminhar, editar e excluir mensagens.
- Busca global, conversas arquivadas e fixadas, rascunhos e contador de não lidas.
- Mensagens temporárias, confirmações de leitura e indicador “digitando…”.
- Formatação estilo WhatsApp (`*negrito*`, `_itálico_`, `~riscado~`, `` `código` ``).
- Temas claro e escuro; perfis com foto e biografia; bloqueio de contatos.

## Segurança

- Senhas com **scrypt**; sessões em cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Conteúdo cifrado no banco com **AES-256-GCM** usando `PEGASUS_MESSAGE_KEY`.
- **Atenção:** o servidor consegue descriptografar as mensagens. Quem tiver o banco **e** a chave consegue lê-las. Não é criptografia de ponta a ponta.
- Nunca faça commit de `.env`, da `DATABASE_URL` ou da chave de mensagens.

## Limitações

- Não há chamadas de áudio/vídeo, notificações push nativas nem sincronização multi-dispositivo.
- A busca varre apenas uma janela de mensagens recentes.
- Mensagens temporárias são removidas quando o servidor processa consultas, não por tarefa em segundo plano.
- No plano gratuito do Render o serviço “dorme” após inatividade; a primeira requisição depois disso demora.
- Os testes em `tests/` ainda não foram adaptados para PostgreSQL (`groups.test.mjs` e `migration.test.mjs` referenciam SQLite).

## Próximas funções recomendadas

1. Backup e exportação de conversas com arquivo protegido por senha.
2. Mensagens agendadas e pastas de conversas personalizadas.
3. Chamadas WebRTC.
4. Criptografia ponta a ponta real, com protocolo revisado (sem inventar algoritmo próprio).
5. Adaptar a suíte de testes ao PostgreSQL e rodá-la em CI.

---

## Histórico de versões

### v1.0

- **Grupos:** botão **+ → Criar um grupo**. Nome, descrição e foto opcionais; até 50 participantes, escolhidos entre os seus contatos (sem bloqueio). Todos enviam texto, imagens, GIFs, áudio, voz, documentos e contatos, e podem responder, reagir, favoritar, fixar e encaminhar.
- **Administração:** quem cria é administrador. Administradores editam nome/descrição/foto, adicionam e removem participantes e promovem/rebaixam outros administradores. O grupo nunca fica sem administrador (se o último sair, o participante mais antigo é promovido).
- **Privacidade em grupos:** quem entra depois **não vê o histórico anterior**. Qualquer participante pode sair; quando o último sai, o grupo é apagado. Avisos automáticos (“X adicionou Y”, “X saiu”) aparecem no chat e não podem ser editados.
- **“Digitando…”** em conversas e grupos (“Ana está digitando…”), em tempo real e sem gravar nada.
- **Contador de não lidas** por conversa e no título da aba.
- **Fixar conversas** no topo (até 5), pelo botão direito na lista.
- **Rascunhos** por conversa, mostrados na lista (“Rascunho: …”).
- **Formatação de texto** estilo WhatsApp/Telegram: `*negrito*`, `_itálico_`, `~riscado~`, `` `código` `` e blocos com três crases; links http/https ficam clicáveis (abrem em nova aba com `noopener`).
- **Popovers acima de janelas modais:** confirmações e reações agora usam a camada superior nativa do navegador.
- **Correções:** corrida ao abrir conversa recém-criada; estilo inline bloqueado pela CSP removido do `index.html`.
- **Migração automática:** a tabela `conversations` de bancos antigos é reconstruída (sem perder conversas nem mensagens) para aceitar grupos.

### v0.9

- **Busca global de mensagens:** procure palavras/frases em conversas acessíveis e salte para o resultado.
- **Mensagens fixadas:** fixe/desafixe pelo menu contextual e abra a lista pelo ícone de marcador no cabeçalho.
- **Reações com emojis:** 👍 ❤️ 😂 😮 😢 🔥 👏 🙏; uma reação ativa por usuário em cada mensagem, que pode ser alterada/removida.
- **Conversas arquivadas:** arquive/desarquive nos detalhes do contato e alterne a lista pelo botão de arquivo. O arquivamento é local.
- **Confirmações de leitura:** mensagens recebidas marcam-se como lidas quando a conversa é aberta; o remetente vê “Lida”.
- **Mensagens temporárias:** escolha 1 hora, 24 horas ou 7 dias para mensagens novas enviadas por você, ou desative. Mensagens vencidas são removidas do banco ao consultar conversas/histórico.
- **Migrações aditivas:** novas tabelas/colunas para reações, fixadas, arquivamento, leitura e expiração são criadas sem apagar o histórico existente.

### v0.8

- **Sem pré-escuta de voz:** ao pressionar **Parar e enviar**, a gravação é enviada automaticamente. Durante a gravação ainda é possível cancelar. O limite é de 2 minutos ou 4 MB.
- **Seleção múltipla de mensagens:** use o menu do botão direito → **Selecionar mensagem**, depois clique em outras mensagens para selecioná-las.
- **Responder mensagem específica:** o balão de resposta mostra uma citação; clicar nela navega até a mensagem original, mesmo que ela esteja fora das últimas 100 mensagens carregadas.
- **Favoritos:** marque mensagens pelo menu contextual e consulte-as no botão de estrela na lista de conversas.
- **Encaminhamento:** envie uma ou várias mensagens selecionadas para outra conversa.
- **Apelidos locais:** dê um apelido a cada contato sem alterar o nome global da conta.
- **Tema claro e escuro:** o escuro é o padrão; a escolha fica salva neste navegador.
- **Detalhes do contato:** clique no nome/foto do cabeçalho para ver e-mail, código Pegasus, data de início da conversa e arquivos compartilhados carregados.
- **Preferências por conversa:** apelido e notificações de navegador podem ser ajustados por contato.
- **Ações de contato:** limpar conversa apenas para você, bloquear/desbloquear o contato e removê-lo da sua lista.
- **Migração aditiva:** as tabelas e colunas novas são criadas automaticamente sem apagar o histórico existente.

> Nota: as versões até a 1.0 usavam SQLite em arquivo. A versão atual usa PostgreSQL; o banco SQLite antigo **não é migrado automaticamente**.

## Licença

Defina a licença do projeto (ex.: MIT) adicionando um arquivo `LICENSE`.
