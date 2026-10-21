<div align="center">
  <img src="public/pegasus-logo.svg" width="160" alt="Logotipo do Pegasus: cavalo alado visto de perfil" />

  # PEGASUS

  **Conversas que atravessam o céu.**

  Um mensageiro em tempo real com estética *Liquid Glass*, identidade espacial azul e elementos de *Art Nouveau*.

  **Versão 0.3.0 · Projeto experimental**
</div>

---

## Sobre o projeto

O **Pegasus** é um aplicativo web de mensagens privadas. Nesta versão, cada pessoa pode criar uma conta, conversar com outra pessoa em tempo real, enviar imagens e GIFs, personalizar uma imagem antes de enviar e controlar as próprias mensagens.

A interface combina **vidro translúcido**, detalhes dourados, uma **constelação de Pegasus** ao fundo e uma logo vetorial que mostra um **cavalo alado de perfil**. As mensagens do usuário aparecem à **direita**; as recebidas, à **esquerda**.

## Funcionalidades

| Recurso | Disponibilidade |
|---|---|
| Cadastro/login por e-mail e senha | ✅ |
| Código de contato único de seis caracteres alfanuméricos | ✅ |
| Iniciar conversa por e-mail **ou** código de contato | ✅ |
| Mensagens de texto em tempo real | ✅ |
| Transformação matemática de texto PG1 | ✅ |
| Imagens PNG/JPEG/WEBP | ✅ |
| GIFs animados selecionados no dispositivo | ✅ |
| Visualizar e editar imagem **antes do envio** | ✅ |
| Desenhar, escrever texto, recortar, filtros e desfazer | ✅ |
| Editar as próprias mensagens de texto | ✅ |
| Apagar as próprias mensagens, sem marcador no chat | ✅ |
| Interface adaptada para celular e computador | ✅ |
| Mensagens salvas em banco de dados SQLite | ✅ |
| Áudio, vídeo, ligações e grupos | Planejado |

### Editor Pegasus Studio

Ao selecionar uma imagem ou um GIF, o **Pegasus Studio** abre uma janela para visualizar o arquivo. Você pode escolher:

- **Desenhar:** definir cor e espessura do pincel; arrastar sobre a imagem.
- **Recortar:** selecionar com o ponteiro a parte que deseja manter.
- **Escrever:** preencher o campo de texto, selecionar a ferramenta Texto e clicar na posição desejada.
- **Filtros:** preto e branco, sépia, frio, vivo e suave.
- **Desfazer/Reiniciar:** recuperar um estado anterior ou recomeçar da imagem original.
- **Adicionar ao chat:** salvar a preparação e enviar usando a seta de envio.

**GIFs**: sem edição, continuam **animados**. Ao desenhar, escrever, recortar ou aplicar filtros, o GIF passa a ser uma **imagem estática** (o navegador não exporta um GIF animado editado nesta versão). O editor informa essa transformação.

**Limites:** 2,5 MB por imagem estática; 4 MB por GIF. Arquivos editados são exportados em WEBP estático e comprimidos para o limite de envio.

### Códigos de contato

Cada usuário recebe automaticamente um identificador exclusivo de **6 caracteres**, composto por letras maiúsculas e números, como `A7K3M9` (exemplo ilustrativo). Ele aparece na parte inferior da barra lateral e pode ser copiado.

Para iniciar uma conversa, clique no botão **+** e escolha **Por e-mail** ou **Por código**. Contas criadas em versões anteriores também recebem um código automaticamente quando o banco é atualizado.

### Controle das mensagens

No balão de uma mensagem enviada por você, utilize **⋯** para:

- **Editar** o texto.
- **Apagar** a mensagem, inclusive imagens/GIFs.

Só o autor pode editar ou excluir. O conteúdo é atualizado para os participantes em tempo real. **O Pegasus não cria um aviso de edição nem um balão “mensagem apagada”.** Imagens e GIFs podem ser excluídos, mas não editados depois do envio; podem ser editados antes de enviar.

> Importante: apagar uma mensagem no servidor não apaga cópias que outra pessoa possa ter salvo, capturado ou recebido anteriormente.

## Tecnologias

| Área | Tecnologia |
|---|---|
| Runtime/backend | Node.js 22.13+ (HTTP nativo) |
| Interface | HTML5, CSS3 e JavaScript ES Modules |
| Editor | Canvas API no navegador |
| Banco | SQLite (`node:sqlite`) |
| Atualizações em tempo real | Server-Sent Events (SSE) |
| Senhas | `scrypt` com salt |
| Criptografia dos dados armazenados | AES-256-GCM |
| Transformação de texto | PG1 — algoritmo customizado |

Sem bibliotecas externas de execução para a versão local.

## Como instalar e executar

1. Instale **Node.js 22.13 ou superior**.
2. Extraia o ZIP e abra a pasta `Pegasus` no VS Code.
3. Execute:

   ```bash
   npm start
   ```

4. Abra **http://localhost:3000** no navegador.

Crie duas contas em navegadores diferentes ou use uma janela anônima para testar a troca de mensagens. O projeto não requer `npm install` para rodar localmente.

Para desenvolvimento com reinício automático:

```bash
npm run dev
```

Para executar a suíte de testes:

```bash
npm test
```

### Atualizando uma versão existente

A versão 0.3 inclui migrações de banco aditivas para criar os novos códigos de contato e o controle de revisões. Ela reconhece as mensagens das versões 0.1/0.2.

1. **Pare o servidor**.
2. Faça **backup da pasta `data/` inteira** da versão antiga, inclusive `local-secret.key` e `pegasus.sqlite` (e seus arquivos auxiliares, se houver).
3. Copie o código novo para a **mesma pasta do projeto**, preservando `data/`.
4. Execute `npm start`. Os campos novos serão adicionados automaticamente.

**Nunca apague a chave usada para proteger as mensagens existentes.** Sem ela, o conteúdo antigo não poderá ser recuperado.

### Configuração em produção

Variáveis relevantes:

| Variável | Descrição |
|---|---|
| `PORT` | Porta do servidor (padrão `3000`) |
| `HOST` | Endereço de bind (padrão `127.0.0.1`) |
| `PEGASUS_DATA_DIR` | Pasta de banco de dados e chave local |
| `PEGASUS_MESSAGE_KEY` | Chave AES de 32 bytes em hexadecimal (64 caracteres) |
| `NODE_ENV` | Defina `production` em produção |

Em produção, `PEGASUS_MESSAGE_KEY` é obrigatória. Utilize HTTPS, backup seguro e armazenamento persistente. Este projeto é **um protótipo**, ainda não está preparado para exposição pública ou grande escala sem auditoria de segurança, limites globais, proteção contra abuso e testes de infraestrutura.

## Como funciona a proteção dos dados

- **Senhas:** armazenadas usando hash `scrypt` com salt; não se guarda a senha em texto simples.
- **Textos:** passam pela transformação **PG1**, que preserva a capacidade de recuperar o texto original. O resultado é protegido no banco com **AES-256-GCM**.
- **Imagens e GIFs:** são mantidos no banco de dados como payload criptografado em repouso; não são processados pela PG1.
- **Sessões:** usam cookie `HttpOnly`, `SameSite=Lax`, duração limitada e token aleatório armazenado como hash.
- **Autorização:** apenas participantes podem abrir uma conversa, e apenas o autor pode editar/apagar sua mensagem.

**PG1 não é criptografia de ponta a ponta.** O servidor pode decifrar mensagens e arquivos para entregá-los às pessoas autorizadas. O protocolo não deve ser utilizado sozinho para comunicações sensíveis. A substituição por um sistema de criptografia ponta a ponta auditado fica para uma futura versão.

## Organização do projeto

```text
Pegasus/
├── public/
│   ├── app.js              # Interface do mensageiro
│   ├── editor.js           # Editor de imagens em Canvas
│   ├── cipher.js           # PG1 — codificação/decodificação
│   ├── styles.css          # Liquid Glass, galáxia e Art Nouveau
│   ├── index.html          # Interface principal
│   ├── pegasus-logo.svg    # Cavalo alado de perfil
│   └── favicon.svg         # Ícone do navegador
├── tests/
│   ├── cipher.test.mjs
│   ├── migration.test.mjs
│   └── server.test.mjs
├── server.mjs              # API HTTP, SSE e SQLite
├── package.json
├── .gitignore
└── README.md
```

O diretório `data/` é criado quando o servidor é iniciado e deve permanecer **fora do Git**.

## Histórico de versões

### v0.3.0 — Pegasus Studio

- Editor de imagens antes do envio, com ferramentas de recorte, desenho, texto, filtros e desfazer.
- Botão dedicado para anexar GIF animado.
- Código de contato alfanumérico, único, com 6 caracteres por usuário.
- Adição de contatos por código **ou** e-mail.
- Edição e exclusão silenciosas das próprias mensagens.
- Remoção do nome do arquivo nos balões e prévias do chat.
- Logo redesenhada para representar o Pegasus completo de perfil.
- Migração automática de usuários antigos e revisão de mensagens.

### v0.2.0 — Mídia e constelação

- Envio de imagens, cores azuis e fundo galáctico.
- Balões enviados à direita e recebidos à esquerda.

### v0.1.0 — Fundação

- Autenticação, chats em tempo real, SQLite e transformação PG1.

## Próximos passos

- Busca ou catálogo de GIFs (além dos arquivos locais).
- Edição de GIFs com manutenção da animação.
- Upload em streaming e mídia armazenada separadamente do SQLite.
- Mensagens de áudio e vídeo.
- Ligações WebRTC.
- Recibos de leitura, presença e notificações.
- Criptografia de ponta a ponta com protocolo auditado.

---

<div align="center"><i>Pegasus — palavras que ganham asas.</i></div>
