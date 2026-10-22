# Pegasus — Mensageiro (v0.8)

**Pegasus** é um protótipo de mensageiro em tempo real com interface Liquid Glass, identidade visual azul inspirada em uma galáxia e a constelação de Pegasus.

> **Status:** protótipo local para desenvolvimento. Ainda não é recomendado para uso público e não possui criptografia de ponta a ponta. PG1 é uma transformação matemática personalizada, não criptografia moderna.

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

### Tema claro/escuro

O Pegasus abre no tema escuro. Use o botão de sol/lua na parte inferior da barra lateral para alternar. A preferência é salva localmente neste navegador.

### Mensagens de voz

1. Abra uma conversa e pressione o botão de microfone.
2. Permita o acesso ao microfone.
3. Fale e acompanhe o contador.
4. Pressione **Parar e enviar** para enviar automaticamente, ou **Cancelar gravação** para descartar.

A gravação usa `MediaRecorder`, funciona em `localhost` durante o desenvolvimento ou em HTTPS quando hospedado. Não há mais pré-escuta antes do envio.

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
3. Substitua os arquivos do programa pelos da v0.8, mas mantenha a pasta `data/`.
4. Execute `npm start`; a migração cria as novas tabelas/colunas sem apagar as mensagens antigas.
5. Se a interface estiver desatualizada, force a atualização com `Ctrl + F5`.

Não apague `local-secret.key`, pois ela é necessária para ler os dados cifrados que já estão armazenados localmente. Em produção, configure `PEGASUS_MESSAGE_KEY` com uma chave persistente e mantenha-a em segredo.

## Próximas funções recomendadas

- mensagens fixadas no topo da conversa;
- busca por texto, remetente, data e tipo de mídia;
- reações com emojis;
- pastas e arquivamento de conversas;
- estados de envio/entrega/leitura;
- mensagens temporárias configuráveis;
- chamadas de áudio/vídeo e criptografia de ponta a ponta real em etapas próprias, com revisão de segurança.

## Commit sugerido

```bash
git add .
git commit -m "feat: adiciona respostas, favoritos, encaminhamento e gestão de contatos"
git push origin main
```

Tag opcional:

```bash
git tag -a v0.8.0 -m "Pegasus v0.8.0 - Gestão avançada de mensagens e contatos"
git push origin v0.8.0
```
