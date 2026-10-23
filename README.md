# Pegasus — Mensageiro (v1.0)

**Pegasus** é um protótipo de mensageiro em tempo real com interface Liquid Glass, identidade visual azul inspirada em uma galáxia e a constelação de Pegasus.

> **Status:** protótipo local para desenvolvimento. Ainda não é recomendado para uso público e não possui criptografia de ponta a ponta. PG1 é uma transformação matemática personalizada, não criptografia moderna.

> **Hospedagem gratuita:** veja o passo a passo em [DEPLOY.md](DEPLOY.md).

## Novidades da v1.0

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

## Novidades da v0.9

- **Busca global de mensagens:** procure palavras/frases em conversas acessíveis e salte para o resultado.
- **Mensagens fixadas:** fixe/desafixe pelo menu contextual e abra a lista pelo ícone de marcador no cabeçalho.
- **Reações com emojis:** 👍 ❤️ 😂 😮 😢 🔥 👏 🙏; uma reação ativa por usuário em cada mensagem, que pode ser alterada/removida.
- **Conversas arquivadas:** arquive/desarquive nos detalhes do contato e alterne a lista pelo botão de arquivo. O arquivamento é local.
- **Confirmações de leitura:** mensagens recebidas marcam-se como lidas quando a conversa é aberta; o remetente vê “Lida”.
- **Mensagens temporárias:** escolha 1 hora, 24 horas ou 7 dias para mensagens novas enviadas por você, ou desative. Mensagens vencidas são removidas do banco ao consultar conversas/histórico.
- **Migrações aditivas:** novas tabelas/colunas para reações, fixadas, arquivamento, leitura e expiração são criadas sem apagar o histórico existente.

## Novidades da v0.8

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
- **Migração SQLite aditiva:** as tabelas e colunas novas são criadas automaticamente sem apagar o histórico existente.

## Funções existentes

- Cadastro e login por e-mail e senha.
- Código de contato alfanumérico único de seis caracteres.
- Conversas privadas por e-mail ou código e solicitações de aprovação.
- Perfis com foto e biografia.
- Mensagens de texto, imagens, GIFs, arquivos de áudio, mensagens de voz, documentos e cartões de contato.
- Edição de texto pelo autor; exclusão para todos pelo autor ou ocultação local de mensagens recebidas.
- Atualização em tempo real via Server-Sent Events (SSE).
- Histórico em SQLite, hash de senha com scrypt e dados cifrados em repouso com AES-256-GCM.
- Menu de mensagem pelo botão direito do mouse e pressionar/segurar em dispositivos de toque.

## Resumo dos novos controles

### Mensagens

- Clique com o botão direito (ou pressione/segure em dispositivo de toque) para abrir as ações.
- **Responder** cria uma citação vinculada à mensagem original.
- **Favoritar** salva a mensagem na coleção pessoal; a estrela é privada para cada conta.
- **Encaminhar** permite escolher outra conversa.
- **Selecionar mensagem** ativa o modo de seleção; clique em outras mensagens para adicionar/remover seleção. A barra superior permite favoritar, encaminhar ou excluir em lote.
- Mensagens suas selecionadas são apagadas para ambos; mensagens recebidas são ocultadas apenas na sua conta.

### Informações do contato

Clique no nome ou na foto do cabeçalho da conversa para abrir os detalhes. O painel permite:

- consultar e copiar e-mail e código Pegasus;
- ver quando a conversa foi iniciada;
- atribuir um apelido que só você vê;
- ativar/desativar notificações do navegador para aquele contato;
- ver e baixar os arquivos presentes no histórico carregado;
- limpar o histórico apenas da sua conta;
- bloquear/desbloquear o contato;
- excluir o contato da sua lista, sem apagar o histórico da outra pessoa.

Quando um contato é bloqueado por qualquer uma das partes, o envio de novas mensagens é impedido até o desbloqueio.

### Busca, fixadas e reações

- Use o ícone de busca no cabeçalho para procurar mensagens por palavra ou frase. A busca considera até 300 mensagens recentes por execução e retorna até 50 resultados.
- No menu contextual da mensagem, escolha **Fixar mensagem** ou **Desafixar mensagem**. Use o ícone de marcador do cabeçalho para listar as mensagens fixadas.
- No menu contextual, escolha **Reagir…** e informe um dos emojis permitidos; ou clique numa reação existente para adicioná-la/removê-la.
- O botão de arquivo na lista alterna entre conversas comuns e arquivadas. Arquivar não apaga o histórico.

### Mensagens temporárias e leitura

- Em detalhes do contato, escolha o prazo para as **mensagens que você enviar dali em diante**. Isso é por remetente: para que as mensagens enviadas pelos dois lados expirem, cada pessoa deve configurar a própria preferência.
- O prazo começa no envio. O servidor remove mensagens vencidas quando o histórico ou a lista de conversas é consultado; não existe tarefa de limpeza em segundo plano.
- Abrir uma conversa marca mensagens recebidas como lidas. O indicador não é um recibo criptograficamente assinado e não equivale a entrega push em dispositivos offline.

### Tema claro/escuro

O Pegasus abre no tema escuro. Use o botão de sol/lua na parte inferior da barra lateral para alternar. A preferência é salva localmente neste navegador.

### Mensagens de voz

1. Abra uma conversa e pressione o botão de microfone.
2. Permita o acesso ao microfone.
3. Fale e acompanhe o contador.
4. Pressione **Parar e enviar** para enviar automaticamente, ou **Cancelar gravação** para descartar.

A gravação usa `MediaRecorder`, funciona em `localhost` durante o desenvolvimento ou em HTTPS quando hospedado. Não há mais pré-escuta antes do envio.

## Limitações importantes

- Ainda é um protótipo 1:1; não há grupos, chamadas de áudio/vídeo reais, sincronização multi-dispositivo, notificações push nativas ou criptografia ponta a ponta.
- A busca varre uma janela limitada de mensagens recentes, não um índice completo.
- Mensagens temporárias são apagadas quando o servidor processa consultas, não por um cronômetro de limpeza em segundo plano; cópias/prints externos não podem ser controlados.
- Confirmações de leitura são simples estados no SQLite.
- PG1 é transformação matemática personalizada, não criptografia moderna; AES-256-GCM protege dados armazenados no servidor, mas o servidor consegue descriptografá-los.

## Próximas funções recomendadas

1. **Backup e exportação de conversas** com arquivo protegido por senha e opções claras de inclusão de mídia.
2. **Rascunhos por conversa** e mensagens agendadas.
3. **Pastas de conversas personalizadas** (trabalho, faculdade, amigos), filtros de não lidas e silenciadas.
4. **Transcrição de áudio local/opcional**, com consentimento explícito.
5. **Chamadas WebRTC** com sinalização, permissões, estados de conexão e tratamento de rede.
6. **Criptografia ponta a ponta real**, com protocolo revisado, gestão/verificação de chaves e testes de segurança; não inventar um algoritmo próprio.
7. **Proteção de tela e bloqueio local** por PIN/biometria do dispositivo quando a plataforma permitir.
8. **Indicador de digitação e presença** com controles de privacidade.

## Stack

- Node.js 22.13+
- HTTP nativo do Node
- SQLite (`node:sqlite`)
- HTML, CSS e JavaScript nativos
- SSE para atualização em tempo real
- scrypt para hash de senhas
- AES-256-GCM para dados cifrados em repouso
- PG1 para transformação matemática do texto

**Segurança:** AES-256-GCM protege o conteúdo armazenado no servidor, mas o servidor tem acesso ao texto necessário para interpretá-lo. A PG1 não substitui criptografia de ponta a ponta. Não use o protótipo para informações sensíveis.

## Instalação

Requisito: Node.js 22.13 ou superior.

```bash
npm start
```

Acesse `http://localhost:3000`.

Para desenvolvimento com reinício automático:

```bash
npm run dev
```

Executar os testes:

```bash
npm test
```

## Atualizar sem perder os dados

1. Pare o servidor.
2. Faça backup de `data/`, especialmente `pegasus.sqlite` e `local-secret.key`.
3. Substitua os arquivos do programa pelos da v0.9, mas mantenha a pasta `data/`.
4. Execute `npm start`; a migração cria as novas tabelas/colunas sem apagar as mensagens antigas.
5. Se a interface estiver desatualizada, force a atualização com `Ctrl + F5`.

Não apague `local-secret.key`, pois ela é necessária para ler os dados cifrados que já estão armazenados localmente. Em produção, configure `PEGASUS_MESSAGE_KEY` com uma chave persistente e mantenha-a em segredo.

## Commit sugerido

```bash
git add .
git commit -m "feat: adiciona busca, reações, mensagens fixadas e temporárias"
git push origin main
```

Tag opcional:

```bash
git tag -a v0.9.0 -m "Pegasus v0.9.0 - Busca, reações e organização"
git push origin v0.8.0
```
