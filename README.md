# Pegasus ✦ — Mensageiro

**Versão 0.1 — MVP com mensagens de texto.**

O Pegasus é uma plataforma web responsiva para troca de mensagens de texto em tempo real. Seu visual combina **Liquid Glass** (vidro translúcido, desfoque e reflexos) com discretos motivos **Art Nouveau** (curvas, ornamentação e tipografia elegante).

> **Atenção:** a transformação matemática PG1 **não é criptografia segura** e não deve ser utilizada para proteger segredos. O projeto adiciona AES-256-GCM para **armazenamento no servidor**, mas **não possui criptografia ponta a ponta**. Para publicar, é indispensável HTTPS, infraestrutura protegida e revisão de segurança.

## O que funciona

- Criar conta com **nome, e-mail e senha**; login e logout.
- Senha armazenada com **scrypt (N=2¹⁷, r=8, p=1, salt individual)** — nunca em texto puro.
- Criar conversa individual digitando o **e-mail exato** de outro usuário cadastrado.
- Enviar e receber **mensagens de texto em tempo real** (HTTP + Server-Sent Events).
- Armazenar usuários, conversas e mensagens em **SQLite**.
- Transformar o texto pelo algoritmo Pegasus PG1 antes de enviar e decifrar no receptor.
- Clicar em **"Ver código PG1"** para ver a transformação da mensagem.
- Preservar acentos, maiúsculas/minúsculas, números e emojis.
- Mensagens armazenadas criptografadas com **AES-256-GCM** (chave de servidor).
- Layout adaptado ao **celular e ao computador**.
- Sessões por cookie `HttpOnly` e `SameSite=Lax`, validação de autorização por conversa, proteção básica contra requisições entre origens e limite de tentativas de login.

## Requisitos

- **Node.js 22.13 ou superior** (recomendado Node.js 24 LTS ou superior).
- Navegador atualizado, como Chrome, Firefox ou Edge.
- **Não precisa instalar dependências npm.** Usa apenas recursos nativos do Node.js.

> O módulo SQLite nativo do Node.js 22 pode exibir um aviso de recurso experimental, sem impedir a execução.

## Como iniciar (Windows, Linux ou macOS)

1. Extraia `Pegasus.zip` e abra a pasta `Pegasus` no Visual Studio Code.
2. Abra o terminal integrado (`Terminal > Novo Terminal`).
3. Execute:

```bash
node --version
npm start
```

4. Abra no navegador **http://127.0.0.1:3000**.
5. Crie uma conta, por exemplo, `alice@exemplo.com`.
6. Abra uma janela **anônima/privativa** do navegador e crie uma segunda conta, por exemplo, `bruno@exemplo.com`.
7. Na conta Alice, clique no botão **+**, digite `bruno@exemplo.com` e clique em **Começar conversa**.
8. Envie mensagens de uma janela para a outra. O recebimento ocorre automaticamente.

No terminal, pressione **Ctrl+C** para encerrar.

### Executar testes

```bash
npm test
```

O teste executa a transformação PG1, verifica cadastro de duas contas, conversas, mensagens e persistência depois de reiniciar o servidor.

## Estrutura do projeto

```text
Pegasus/
├── server.mjs          # HTTP, autenticação, SQLite, criptografia AES e SSE
├── package.json        # npm start / npm test
├── public/
│   ├── index.html      # telas de login, cadastro e chat
│   ├── styles.css      # tema Liquid Glass + Art Nouveau
│   ├── app.js          # interface, requisições, envio e atualização
│   ├── cipher.js       # codificador e decodificador Pegasus PG1
│   └── favicon.svg     # marca visual
├── tests/
│   ├── cipher.test.mjs
│   └── server.test.mjs
├── data/               # SQLite e chave local gerados ao executar (não inclua no Git)
└── README.md
```

## Como a transformação Pegasus PG1 funciona

Ela respeita as operações propostas. Para tornar a fórmula determinística, foi preciso formalizar alguns conceitos que ainda estavam ambíguos:

1. **"Primo mais próximo"**: o primo com menor distância do número intermediário; em empate, vence o menor.
2. **"Segundo primo mais próximo"**: o segundo na ordenação por distância, depois de remover o primeiro; em empate, vence o menor.
3. **Vogais**: posição da letra A=1 até Z=26, soma 42, divide pelo primo mais próximo da soma, e, quando o quociente não é inteiro, arredonda para cima quando a posição da letra é ímpar e para baixo quando é par. Depois multiplica por 5 e subtrai 7. *Todas as posições das vogais A/E/I/O/U são ímpares.*
4. **Consoantes**: posição multiplicada por 13. Se o resultado for ímpar, divide pelo primo mais próximo; se for par, multiplica pelo **segundo** primo mais próximo. Multiplica o resultado por **3.1415926535897** (14 primeiros algarismos de π), divide por 2 e subtrai 2. A representação numérica é arredondada para 8 casas decimais para manter os tokens consistentes.
5. **Números**: utilizam exatamente a tabela fornecida no pedido.
6. **Emojis e outros símbolos**: permanecem literalmente na representação PG1; `⟦` e `⟧` recebem escape porque são delimitadores de tokens.
7. **Acentos e caixa**: informações adicionais no token possibilitam reconstruir `á`, `ç`, `Ã`, etc.
8. **Resultados duplicados**: a equação gera, por exemplo, `-2` para **A, E, I e O**. O PG1 acrescenta um índice de desambiguação. Sem isso, a operação inversa perderia as letras originais.

### Exemplo

Texto original:

```text
Oi! 123 🪽
```

Em formato PG1:

```text
PG1|⟦V:-2:3:U:-⟧⟦V:-2:2:L:-⟧! ⟦N:#$@⟧⟦N:(;>⟧⟦N:ui[&⟧ 🪽
```

Ao receber, a outra conta executa `decodePegasus` e mostra `Oi! 123 🪽`.

> A transformação PG1 é uma **substituição reversível e previsível**. O índice de desambiguação não cria segurança criptográfica. Qualquer pessoa com o código pode interpretá-la.

### Proteção diferente da transformação PG1

- **Senhas**: hash `scrypt` com sal individual, sem possibilidade de recuperar o texto original a partir do cadastro.
- **Mensagens**: antes de gravar no SQLite, o servidor cifra o texto transformado com **AES-256-GCM** (autenticação de integridade e IV aleatório por mensagem).
- **Chave**: no ambiente local, criada automaticamente em `data/local-secret.key` e usada nas próximas inicializações. **Nunca compartilhe, envie ao Git ou apague essa chave sem um backup seguro**, pois perder a chave significa perder a capacidade de decifrar as mensagens antigas.
- **Em produção**: defina `PEGASUS_MESSAGE_KEY` como 64 dígitos hexadecimais, forneça HTTPS no proxy reverso e defina `NODE_ENV=production`. O servidor rejeitará inicialização em produção sem chave de ambiente.
- **Não é ponta a ponta**: o servidor possui a chave e consegue recuperar as mensagens. Implementar criptografia ponta a ponta exigirá um protocolo padronizado com gerenciamento e troca segura de chaves.

## Limitações desta primeira versão

- Somente conversas **entre duas pessoas** e texto (até 4.000 caracteres por mensagem).
- Busca apenas entre conversas já iniciadas; novos contatos são encontrados pelo e-mail exato.
- O histórico recupera as **100 mensagens mais recentes** por conversa; paginação virá depois.
- **Não** tem anexos, imagens, vídeos, GIFs, mensagens de voz, chamadas, grupo, notificações push ou confirmação de leitura.
- E-mails ainda **não são verificados** — para disponibilizar publicamente, adicione envio de link de verificação, redefinição de senha, políticas de abuso e medidas contra spam.
- Aplicação preparada para **uso local, demonstração e evolução**. Não publique na internet sem HTTPS, configuração segura da infraestrutura e uma revisão técnica.
- SQLite em um único processo funciona bem para protótipos; para expansão horizontal considere PostgreSQL e um sistema de eventos como Redis.

## Próximos passos recomendados

1. Melhorar perfil do usuário e buscas de contatos.
2. **Criptografia ponta a ponta verdadeira**, usando bibliotecas e protocolos criptográficos auditados e um modelo de chaves por dispositivo.
3. Imagens, vídeos, GIFs e áudios (com armazenamento protegido e políticas de acesso).
4. Notificações push, confirmação de leitura, edição e exclusão de mensagens.
5. **Chamadas de voz e vídeo com WebRTC**, sinalização autenticada e suporte a servidores STUN/TURN.
6. PWA e, se necessário, aplicativo Android/iOS reaproveitando a interface web.

## Avisos para executar publicamente

Nunca envie a pasta `data/` ou chaves para um repositório. Em servidores públicos, mantenha a base de dados em volume persistente, configure HTTPS, backups, limites de acesso, autenticação de e-mail, observabilidade, políticas de retenção e testes de segurança. Não use HTTP sem TLS na internet ou numa rede compartilhada: o PG1 não protege mensagens ou credenciais no transporte.
#   P e g a s u s  
 