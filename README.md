<div align="center">
  <img src="public/pegasus-logo.svg" alt="Pegasus: cavalo branco de perfil, crina azulada, olhar sério e asa abaixo do rosto" width="170" />

  # PEGASUS

  **Converse sob as estrelas.**

  Mensagens, imagens, GIFs, privacidade e identidade visual inspirada na constelação de Pegasus.

  ![Versão](https://img.shields.io/badge/versão-0.4.0-73bfff) ![Node](https://img.shields.io/badge/Node-22.13%2B-91c6ed) ![Status](https://img.shields.io/badge/status-beta-2d75ad)
</div>

---

## ✨ Sobre o projeto

O **Pegasus** é um site de mensagens instantâneas desenvolvido com **Node.js, HTML, CSS e JavaScript**. Seu visual combina efeitos translúcidos *Liquid Glass*, tons de azul profundo, estrelas e detalhes de Art Nouveau.

Nesta fase, o aplicativo funciona localmente ou em uma infraestrutura Node.js configurada pelo desenvolvedor. Ainda é um protótipo beta e não é recomendado para uso público sem revisão adicional de segurança, escalabilidade e privacidade.

## 🚀 Recursos disponíveis

| Recurso | Status |
|---|---|
| Cadastro e login com e-mail e senha | ✅ |
| Código Pegasus individual com seis caracteres | ✅ |
| Buscar contatos por e-mail **ou** código | ✅ |
| Mensagens em tempo real (SSE) | ✅ |
| Editar e excluir mensagens próprias sem aviso no chat | ✅ |
| Enviar PNG, JPG, WEBP e GIF | ✅ |
| Pré-visualização e edição de imagens antes de enviar | ✅ |
| Perfil com foto e bio | ✅ **novo** |
| Escolher privacidade de novas conversas | ✅ **novo** |
| Receber, aceitar e recusar solicitações de conversa | ✅ **novo** |
| Ligações de áudio e vídeo | 🔜 Planejado |

## 🆕 Novidades da v0.4

### Logo atualizada

A nova logo mostra **somente o rosto de Pegasus de perfil**, com pelagem branca, crina azulada, olhar sério e **uma asa abaixo da cabeça**. O desenho é vetorial e está em `public/pegasus-logo.svg`; o favicon acompanha o mesmo tema.

### Perfil personalizado

No rodapé da barra lateral, clique no botão **⚙ Meu perfil** para:

- adicionar ou remover foto de perfil;
- escrever uma bio de até **240 caracteres**;
- conferir seu código Pegasus;
- selecionar quem pode iniciar conversas com você.

A foto é recortada automaticamente como avatar quadrado no navegador e salva em formato JPEG (até 240 KB). As fotos e bios dos contatos aparecem na lista e no cabeçalho de conversas existentes.

### Privacidade de novas conversas

**Modo aberto (padrão):** outra pessoa que saiba seu e-mail ou código Pegasus pode iniciar uma conversa diretamente.

**Modo com aprovação:** novas pessoas podem encontrá-lo por e-mail ou código, mas não conseguem iniciar uma conversa até você **aceitar** uma solicitação. Use o botão ✉ na barra lateral para ver solicitações, aceitar ou recusar.

**Regras importantes:**

- a solicitação pendente **não** cria uma conversa nem permite enviar mensagens;
- apenas o destinatário pode aceitar ou recusar;
- solicitações repetidas não criam duplicatas;
- uma solicitação recusada não pode ser reenviada enquanto o destinatário mantém o modo restrito;
- conversas que já existiam continuam disponíveis após alterar a privacidade.

### Editor de imagens simplificado

Ao selecionar uma imagem ou GIF, uma janela de pré-visualização aparece. O editor concentra os comandos em uma **barra compacta**:

- **Desenhar** — cor e espessura do pincel;
- **Recortar** — arraste sobre a área que quer manter;
- **Texto** — escreva e toque na imagem;
- **Filtros rápidos** — P&B, Frio e Vivo;
- **Desfazer** e **Limpar**.

O GIF sem edição mantém sua animação. Editar um GIF converte o quadro visível em imagem estática WEBP.

## 🛠️ Tecnologias

- **Node.js 22.13+** (módulos nativos `http`, `crypto` e `node:sqlite`)
- **SQLite** para persistência de usuários, conversas, mensagens e solicitações
- **Server-Sent Events (SSE)** para atualizações em tempo real
- **HTML + CSS + JavaScript** no frontend
- **Canvas API** para edição de imagens
- **PG1** para transformação matemática reversível de mensagens de texto
- **scrypt** para senhas; **AES-256-GCM** para mensagens armazenadas

> PG1 **não é criptografia de ponta a ponta**. O servidor consegue recuperar as mensagens e os anexos armazenados. Não armazene informações sensíveis nesse protótipo sem avaliar os riscos e adicionar as proteções necessárias.

## 📂 Estrutura

```text
Pegasus/
├── public/
│   ├── index.html           # Login, chat, perfil, solicitações e editor
│   ├── styles.css           # Liquid Glass e interface responsiva
│   ├── app.js               # Interface e chamadas à API
│   ├── editor.js            # Editor de imagens e GIFs
│   ├── cipher.js            # Transformação PG1
│   ├── pegasus-logo.svg     # Rosto branco com crina azul e asa inferior
│   └── favicon.svg
├── tests/
│   ├── cipher.test.mjs
│   ├── server.test.mjs
│   ├── migration.test.mjs
│   └── profile-privacy.test.mjs
├── server.mjs               # API HTTP, autenticação, SSE e SQLite
├── package.json
├── .gitignore
└── README.md
```

A pasta `data/` aparece automaticamente ao executar o projeto. Ela não deve ser enviada ao GitHub.

## ▶️ Executar localmente

**Pré-requisito:** Node.js 22.13.0 ou posterior.

```bash
# 1. Entre na pasta descompactada
cd Pegasus

# 2. Execute o servidor
npm start
```

Acesse **http://localhost:3000**.

O projeto utiliza apenas módulos nativos do Node.js, portanto, não depende de um `npm install` adicional nesta versão.

### Testar com duas contas

Abra uma janela normal e uma anônima ou dois navegadores. Crie contas diferentes, inicie uma conversa pelo e-mail ou pelo código de contato e teste mensagens e imagens. Para testar solicitações, ative **Apenas com minha aprovação** em uma das contas.

### Rodar testes

```bash
npm test
```

Os testes verificam a criptografia PG1, cadastro/login, persistência de dados, edição/exclusão de mensagens, envio de mídias, migração de bancos antigos, perfil e solicitações de conversa.

## ♻️ Atualização de v0.3 para v0.4

1. **Pare o servidor antigo.**
2. Faça um **backup completo da pasta `data/`**, inclusive de `pegasus.sqlite` e `local-secret.key`.
3. Substitua os arquivos de código pela v0.4 (sem apagar a pasta `data/`).
4. Execute `npm start` novamente.

O servidor realiza uma migração **aditiva** no banco de dados, criando os novos campos e a tabela de solicitações sem apagar as conversas anteriores. Em produção, mantenha também a mesma `PEGASUS_MESSAGE_KEY`.

## 🔐 Avisos de segurança e limitações

- A primeira versão usa cookies HttpOnly com sessões e armazenamento cifrado no servidor; **não é E2EE**.
- O modo com aprovação controla **novas conversas**. Não cancela conversas que já foram autorizadas.
- Envio de imagem: PNG/JPG/WEBP até **2,5 MB**; GIF até **4 MB**.
- Foto de perfil é pública para participantes de conversas e remetentes de solicitações; escolha-a conscientemente.
- Ainda faltam recursos como recuperação de senha, bloqueio de contatos, controle antifraude robusto, limites de armazenamento e infraestrutura de produção.

## 🗺️ Roadmap

- [x] v0.1 — Mensagens de texto e cadastro
- [x] v0.2 — Envio de imagens e tema galáctico
- [x] v0.3 — GIFs, editor, códigos e edição de mensagens
- [x] v0.4 — Fotos e bios, aprovação de contatos, editor simplificado, logo renovada
- [ ] v0.5 — Áudios, respostas, bloqueio e notificações
- [ ] Futuro — Vídeo e chamadas de áudio/vídeo

## 💻 Commit sugerido

```bash
git add .
git commit -m "feat: adiciona perfis, privacidade de conversas e nova identidade visual ao Pegasus"
git push origin main
```

---

<div align="center"><strong>PEGASUS · Palavras que ganham asas.</strong></div>
