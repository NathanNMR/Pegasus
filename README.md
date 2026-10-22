# Pegasus — Mensageiro com mensagens de voz (v0.7)

**Pegasus** é um protótipo de aplicativo/site de conversas em tempo real, com interface *Liquid Glass* e referências de *Art Nouveau*. A identidade visual utiliza um céu de nebulosas azuis e o desenho da constelação de Pegasus, agora sem nomes de estrelas nem a palavra “PEGASUS” sobre o céu.

> **Status:** protótipo para desenvolvimento e testes locais. Ainda não é um mensageiro seguro para uso público nem oferece criptografia de ponta a ponta.

## O que o Pegasus faz

- Cadastro e login por **e-mail e senha**.
- Código de contato alfanumérico de **6 caracteres** para cada usuário.
- Conversas privadas encontradas por e-mail ou código.
- Configuração de privacidade para iniciar conversas livremente ou exigir **solicitação de aprovação**.
- Perfis com **foto e biografia**.
- Envio de mensagens de texto atualizadas em tempo real.
- Envio de **imagens, GIFs animados, arquivos de áudio e documentos**.
- **Mensagens de voz gravadas pelo microfone**, com pré-escuta, descarte e reprodução diretamente na conversa.
- **Compartilhamento de contato** de pessoas com quem o remetente já possui uma conversa.
- Menu de mensagem pelo **botão direito**, edição pelo autor, exclusão para todos pelo autor ou ocultação individual pelo destinatário, sem mensagens de aviso no histórico.
- Histórico salvo em SQLite.
- Tema visual em azul, logo de Pegasus, favicon **circular com cantos transparentes**, sem emblema quadrado.

## Novidades da v0.7 — Gravação pelo microfone

O campo de mensagens agora possui um **botão de microfone**, separado do botão **+** de anexos, para gravar e enviar mensagens de voz sem escolher um arquivo. O visual segue o tema azul e o menu de anexos existente continua disponível.

**Como usar:**

1. Abra uma conversa e clique no botão de **microfone** à direita da área de texto.
2. Autorize o uso do microfone quando solicitado pelo navegador.
3. Fale normalmente e acompanhe o tempo de gravação.
4. Clique em **Parar gravação**.
5. Escute a prévia, **Descarte** ou clique em **Enviar áudio**.
6. A mensagem aparece no chat com um reprodutor; o contato também poderá ouvi-la.

**Regras da gravação:**

- Até **2 minutos** e **4 MB** por mensagem de voz, com tratamento de erros e liberação do microfone ao parar/cancelar.
- A gravação é local, feita pela API `MediaRecorder` do navegador. O Pegasus tenta WEBM/Opus, M4A/MP4 ou OGG conforme a disponibilidade.
- A permissão para o microfone é solicitada somente quando o usuário inicia uma gravação.
- Funciona em **localhost** durante o desenvolvimento ou em uma página com **HTTPS** ao publicar; páginas HTTP comuns não dão acesso ao microfone.
- Ao trocar de conversa ou sair da conta, a gravação pendente é cancelada para impedir o envio ao contato errado.
- **Áudio de arquivo** continua disponível pelo botão **+** → **Áudio**.
- O áudio segue a proteção de armazenamento já existente (AES-256-GCM no servidor), mas **não** é criptografado de ponta a ponta.

**Teste e compatibilidade:** `npm test` executa testes de API, persistência e um simulador do controle de gravação. A navegação automatizada ao localhost foi bloqueada no ambiente de desenvolvimento desta entrega; teste a captação física com o microfone de seu computador ou celular.

## Funcionalidades herdadas da v0.6

### Um único botão de anexos

No campo de mensagem, o botão **+** abre um pequeno menu que não cobre a conversa. Há cinco opções:

| Opção | Comportamento |
|---|---|
| **Imagem** | Seleciona PNG/JPEG/WEBP e abre o Pegasus Studio para pré-visualizar e editar antes do envio |
| **GIF** | Seleciona GIF do dispositivo e permite visualizá-lo; GIF sem edição mantém a animação |
| **Áudio** | Seleciona um arquivo de áudio e o envia com reprodutor no chat |
| **Documento** | Seleciona um documento e o disponibiliza para download na conversa |
| **Contato de alguém** | Exibe uma lista de contatos de conversas existentes; o destinatário recebe um cartão com código Pegasus |

**Tipos e limites na versão local:**

- Imagens PNG, JPEG e WEBP: até **2,5 MB**.
- GIFs: até **4 MB**.
- Áudios MP3, WAV, OGG, M4A, WEBM e FLAC: até **4 MB**.
- Documentos PDF, TXT, DOC, DOCX, XLS, XLSX, PPT, PPTX, ODT e ODS: até **4 MB**.

O Pegasus verifica a extensão e a assinatura básica dos arquivos no servidor. Os limites não ficam mais escritos abaixo do campo de mensagem; continuam valendo para não sobrecarregar o protótipo. O editor não é aplicado a áudio ou documento. **Além de anexar áudio pronto, agora é possível gravar diretamente pelo microfone.** Para GIFs, o editor converte para uma imagem estática caso o usuário aplique alterações.

### Constelação sem textos

O arquivo `public/pegasus-constellation.svg` não contém mais o nome das estrelas nem o título "PEGASUS". As linhas, estrelas e brilho continuam aparecendo sobre a galáxia.

### Favicon somente circular

`public/favicon.png` é um PNG com fundo transparente fora do círculo. A versão no navegador pode demorar a atualizar se estiver armazenada em cache.

## Arquitetura

| Parte | Tecnologia |
|---|---|
| Servidor | Node.js 22.13+, HTTP nativo |
| Banco de dados | SQLite (`node:sqlite`) |
| Atualização de conversas | Server-Sent Events (SSE) |
| Interface | HTML, CSS e JavaScript nativos |
| Proteção de senhas | scrypt com salt |
| Proteção dos dados armazenados | AES-256-GCM no servidor |
| Transformação personalizada de texto | PG1 |

**Importante:** PG1 é uma transformação matemática personalizada e **não é criptografia de ponta a ponta**. Os participantes veem o texto interpretado na conversa, não a codificação interna. O servidor tem acesso ao conteúdo necessário para funcionar. Imagens, áudios e documentos são cifrados em repouso no servidor, mas não têm proteção de ponta a ponta.

## Instalação

1. Instale o **Node.js 22.13 ou superior**.
2. Extraia o ZIP e abra a pasta `Pegasus` no VS Code.
3. Execute:

```bash
npm start
```

4. Acesse **http://localhost:3000**.

Para atualizar automaticamente durante a edição do código:

```bash
npm run dev
```

Para realizar os testes:

```bash
npm test
```

## Teste com duas contas

1. Abra o Pegasus no navegador e registre a primeira conta.
2. Abra uma janela anônima e registre a segunda conta.
3. Inicie uma conversa usando o e-mail ou código Pegasus de seis caracteres.
4. Envie texto ou utilize **+** para abrir o menu de anexos; para gravar uma mensagem de voz, utilize o novo botão de microfone.
5. Escolha uma imagem, GIF, áudio, documento ou contato.
6. Confira o recebimento na outra conta e o histórico após reiniciar o servidor.
7. Para testar compartilhamento de contato, crie uma terceira conta e inicie uma conversa com ela antes de selecionar **Contato de alguém**.

## Atualizar uma versão anterior sem perder os dados

1. **Pare o servidor.**
2. Faça backup da pasta `data/`, especialmente de `pegasus.sqlite` e `local-secret.key`.
3. Substitua os arquivos do programa pelos arquivos da v0.7.
4. Preserve a pasta `data/` anterior e reinicie com `npm start`.
5. Force a atualização do navegador com `Ctrl + F5` se o ícone ou estilos antigos permanecerem no cache.

Não apague `local-secret.key`: ela é usada para recuperar os conteúdos já armazenados localmente. No ambiente de produção, configure `PEGASUS_MESSAGE_KEY` de forma persistente e mantenha-a em segredo.

## Organização dos arquivos

```text
Pegasus/
├── public/
│   ├── index.html                   # Login, conversas, menu compacto, modais
│   ├── styles.css                   # Layout responsivo e Liquid Glass
│   ├── app.js                       # Lógica do cliente e envio dos anexos
│   ├── voice-recorder.js            # Gravação de voz, prévia e integração ao chat
│   ├── editor.js                    # Pegasus Studio
│   ├── cipher.js                    # Transformação matemática PG1
│   ├── pegasus-logo.png             # Logo do projeto
│   ├── favicon.png                  # Ícone circular transparente
│   ├── pegasus-galaxy.svg           # Fundo de galáxia
│   └── pegasus-constellation.svg    # Constelação sem nomes
├── tests/                           # Testes de backend e migração
├── server.mjs                       # API, sessões, SSE e armazenamento
├── package.json
├── .gitignore
└── README.md
```

## Limitações e próximos passos

O objetivo desta etapa é validar um protótipo, não hospedar um serviço público em escala. Os arquivos são salvos codificados dentro das mensagens no banco SQLite. A solução precisará migrar para armazenamento de objetos, processamento de mídia, antivírus, limites de uso e otimização de download antes de atender muitas pessoas.

Ainda faltam chamadas de voz/vídeo em tempo real, indicadores de entrega/leitura, moderação, proteção antiabuso mais abrangente e uma arquitetura real de criptografia de ponta a ponta.

## Commit sugerido

```bash
git add .
git commit -m "feat: implementa gravacao e envio de mensagens de voz no Pegasus"
git push origin main
```

Para criar uma versão no GitHub:

```bash
git tag -a v0.7.0 -m "Pegasus v0.7.0 - Mensagens de voz"
git push origin v0.7.0
```
