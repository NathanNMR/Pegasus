# Deploy do Pegasus: Render + Aiven (PostgreSQL)

O Pegasus precisa de um processo Node ligado, **HTTPS** (o cookie de sessão é `Secure` em produção) e um **PostgreSQL**. O Render hospeda o app via Docker e o Aiven hospeda o banco. Como o banco é externo, o disco efêmero do Render não faz diferença.

## 1. Criar o banco no Aiven

1. Crie um serviço **PostgreSQL** (há plano gratuito).
2. Em **Overview**, copie a **Service URI**:
   `postgres://avnadmin:SENHA@pg-xxxx.aivencloud.com:PORTA/defaultdb?sslmode=require`
3. Baixe o **CA certificate** (`ca.pem`) e abra-o em um editor de texto.
4. Em **Allowed IP addresses**, confirme que o acesso externo está liberado (por padrão `0.0.0.0/0`).

## 2. Gerar a chave das mensagens

```bash
openssl rand -hex 32
```

**Guarde uma cópia em um gerenciador de senhas.** Se você perder ou trocar essa chave, as mensagens já gravadas ficam ilegíveis.

## 3. Criar o serviço no Render

**Opção A, Blueprint:** *New → Blueprint*, selecione o repositório. O `render.yaml` cria o serviço e pede os valores secretos.

**Opção B, manual:** *New → Web Service*, selecione o repositório e configure:

| Campo | Valor |
|---|---|
| Runtime | Docker |
| Branch | `main` |
| Health Check Path | `/api/health` |

### Variáveis de ambiente

| Variável | Valor |
|---|---|
| `DATABASE_URL` | Service URI do Aiven |
| `PG_CA_CERT` | Conteúdo completo do `ca.pem`, de `-----BEGIN CERTIFICATE-----` até `-----END CERTIFICATE-----` |
| `PEGASUS_MESSAGE_KEY` | Resultado do `openssl rand -hex 32` |
| `PEGASUS_TRUST_PROXY` | `1` |

`NODE_ENV`, `HOST`, `PORT` e `PEGASUS_DATA_DIR` já vêm do Dockerfile.

Na `DATABASE_URL` o `?sslmode=require` pode ficar: o servidor o remove e controla o SSL pelo `PG_CA_CERT`. Se a senha tiver caracteres especiais (`@`, `/`, `#`), use a versão codificada que o Aiven mostra.

## 4. Primeiro deploy

Clique em **Manual Deploy → Clear build cache & deploy**. Nos logs, procure por:

- `RUN npm ci --omit=dev` concluído na etapa de build;
- `Pegasus` escutando na porta, sem erros de conexão com o banco.

As tabelas são criadas sozinhas na primeira inicialização.

## Solução de problemas

| Erro no log | Causa e solução |
|---|---|
| `Cannot find package 'pg'` | O Dockerfile não instalou as dependências. Use o `Dockerfile` deste repositório (com `npm ci`) e limpe o cache de build |
| `Defina DATABASE_URL...` | Variável ausente no Render |
| `self-signed certificate in certificate chain` | `PG_CA_CERT` ausente ou incompleto. Cole o `ca.pem` inteiro, incluindo as linhas BEGIN/END |
| `Defina PEGASUS_MESSAGE_KEY para executar em produção` | Variável ausente |
| `PEGASUS_MESSAGE_KEY precisa ter 64 caracteres hexadecimais` | Gere de novo com `openssl rand -hex 32` e cole sem espaços |
| `EACCES: permission denied, mkdir '/data'` | Dockerfile antigo; o atual cria `/data` com permissão para o usuário `node` |
| `password authentication failed` / `ENOTFOUND` | URI copiada errada ou serviço Aiven desligado |
| `ETIMEDOUT` / `ECONNREFUSED` | IP do Render bloqueado em *Allowed IP addresses* do Aiven |
| Login falha para todos depois de poucas tentativas | Falta `PEGASUS_TRUST_PROXY=1` |

## Limitações do plano gratuito

- O Render suspende o serviço após inatividade; a primeira requisição depois disso demora cerca de um minuto. Conexões SSE caem nesse intervalo e o front-end reconecta.
- Confira os limites e a retenção do plano gratuito do Aiven; planos gratuitos podem ter armazenamento limitado ou ser desligados por inatividade.

## Backup

Com `postgresql-client` instalado e `DATABASE_URL` no ambiente:

```bash
./deploy/backup.sh
```

Gera um dump em `/var/backups/pegasus` e mantém os 14 mais recentes. Restaurar:

```bash
pg_restore --no-owner --clean --dbname "$DATABASE_URL" arquivo.dump
```

Guarde também a `PEGASUS_MESSAGE_KEY`: o banco restaurado só é legível com a mesma chave.

## Atualizar o app

```bash
git add . && git commit -m "fix: deploy" && git push origin main
```

Com `autoDeploy` ativo, o Render faz o deploy sozinho. O servidor migra o banco quando necessário.

## Alternativa: VM própria (Oracle Cloud, VPS…)

Os arquivos em `deploy/` (`pegasus.service`, `Caddyfile`, `pegasus.env.example`, `backup.sh`) servem para rodar com systemd e Caddy (HTTPS automático) em uma VM Ubuntu:

```bash
sudo git clone https://github.com/SEU_USUARIO/Pegasus.git /opt/pegasus
cd /opt/pegasus && sudo npm ci --omit=dev
sudo cp deploy/pegasus.env.example /etc/pegasus.env     # preencha DATABASE_URL, PEGASUS_MESSAGE_KEY, PG_CA_CERT
sudo chmod 600 /etc/pegasus.env
sudo cp deploy/pegasus.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pegasus
```

Depois configure o Caddy com seu domínio (`deploy/Caddyfile`). Não é preciso criar um `PEGASUS_DATA_DIR` persistente, pois os dados ficam no PostgreSQL.
