# Hospedar o Pegasus de graça

O Pegasus é um servidor Node (≥ 22.13) com banco **SQLite em arquivo** e conexões em tempo real (SSE). Por isso, a hospedagem precisa de:

1. um processo Node **ligado o tempo todo** (nada de "serverless");
2. um **disco que não se apaga** (onde ficam o banco e as mensagens);
3. **HTTPS** (o cookie de sessão é `Secure` em produção).

A maioria dos planos gratuitos de PaaS não oferece o item 2 (o disco é apagado a cada reinício). Por isso o caminho recomendado é uma VM gratuita.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `NODE_ENV=production` | Ativa cookie `Secure` e exige a chave abaixo |
| `HOST=0.0.0.0` | Padrão é `127.0.0.1` (só acessível na própria máquina). Use `0.0.0.0` em contêiner/PaaS; `127.0.0.1` se houver Caddy/Nginx na mesma máquina |
| `PORT` | Porta (padrão 3000; PaaS costuma definir sozinho) |
| `PEGASUS_MESSAGE_KEY` | 64 caracteres hex. Gere com `openssl rand -hex 32`. **Guarde uma cópia**: sem ela as mensagens existentes ficam ilegíveis |
| `PEGASUS_DATA_DIR` | Pasta do banco (precisa ser disco persistente) |
| `PEGASUS_TRUST_PROXY=1` | Obrigatório atrás de proxy/túnel; sem isso o limite de tentativas de login vale para **todos os usuários juntos** |

---

## Caminho A (recomendado): VM "Always Free" da Oracle Cloud + HTTPS grátis

Gratuito sem prazo, com disco persistente. Pede cartão para verificar a conta (não é cobrado dentro dos limites gratuitos). Confira os limites atuais em oracle.com/cloud/free — eles já mudaram antes (hoje relatam 2 OCPU/12 GB na VM ARM, além de VMs AMD "Micro" de 1 GB, que bastam para o Pegasus). A Oracle também pode recuperar instâncias ociosas: mantenha backups.

### 1. Criar a VM
1. Crie a conta e escolha a **região de origem** com cuidado (não dá para trocar depois; São Paulo/Vinhedo funcionam).
2. *Compute → Instances → Create*: imagem **Ubuntu 24.04**, forma **VM.Standard.E2.1.Micro** (ou Ampere A1 se houver capacidade; "Out of capacity" é comum, tente outro horário).
3. Baixe a chave SSH e anote o **IP público**.
4. Na rede da VM (*VCN → Security List*), adicione regras de entrada TCP nas portas **80** e **443** (origem `0.0.0.0/0`).

### 2. Domínio gratuito
Em duckdns.org crie um subdomínio (ex.: `meupegasus.duckdns.org`) apontando para o IP da VM.

### 3. Preparar o servidor
```bash
ssh -i sua-chave ubuntu@IP_DA_VM

# Firewall do Ubuntu da Oracle (além da regra na nuvem)
sudo iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save

# Node 22, git, sqlite3 (para backup) e Caddy (HTTPS automático)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git sqlite3 caddy
node -v   # precisa ser v22.13 ou mais novo
```

### 4. Instalar o app
```bash
sudo useradd --system --home /opt/pegasus --shell /usr/sbin/nologin pegasus
sudo git clone https://github.com/SEU_USUARIO/Pegasus.git /opt/pegasus
sudo mkdir -p /var/lib/pegasus && sudo chown pegasus: /var/lib/pegasus && sudo chmod 700 /var/lib/pegasus

sudo cp /opt/pegasus/deploy/pegasus.env.example /etc/pegasus.env
sudo sed -i "s|^PEGASUS_MESSAGE_KEY=.*|PEGASUS_MESSAGE_KEY=$(openssl rand -hex 32)|" /etc/pegasus.env
sudo chmod 600 /etc/pegasus.env
sudo cat /etc/pegasus.env     # copie a PEGASUS_MESSAGE_KEY para um lugar seguro (gerenciador de senhas)

sudo cp /opt/pegasus/deploy/pegasus.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pegasus
sudo systemctl status pegasus        # deve estar "active (running)"
```

### 5. HTTPS
```bash
sudo cp /opt/pegasus/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile       # troque o domínio pelo seu
sudo systemctl reload caddy
```
Abra `https://seu-dominio.duckdns.org`. Crie sua conta e pronto.

### 6. Backup diário (importante)
```bash
sudo crontab -e
# adicione:
17 3 * * * /opt/pegasus/deploy/backup.sh
```
Baixe os backups de tempos em tempos (`scp`) para outro lugar; uma cópia na mesma VM não protege contra perder a VM.

### 7. Atualizar o app depois
```bash
cd /opt/pegasus && sudo git pull && sudo systemctl restart pegasus
```
(O servidor migra o banco sozinho quando necessário.)

---

## Caminho B: no seu computador, com link público (para testar ou usar com amigos)

Grátis e sem cartão, mas só funciona com o PC ligado e o link muda a cada execução.

```bash
export NODE_ENV=production HOST=127.0.0.1 PEGASUS_TRUST_PROXY=1
export PEGASUS_MESSAGE_KEY=$(openssl rand -hex 32)    # guarde esta chave
npm start
# em outro terminal (instale o cloudflared: developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads)
cloudflared tunnel --url http://localhost:3000
```
Ele mostra um endereço `https://….trycloudflare.com` para compartilhar. Para o link ser fixo é preciso um domínio no Cloudflare (túnel nomeado, também gratuito).

## Caminho C: serviços gratuitos que "dormem" (só para demonstração)

Planos gratuitos de PaaS (como o Render) normalmente suspendem o app quando ocioso e **apagam o disco** a cada reinício ou novo deploy. No Pegasus isso significa perder contas e mensagens. Serve para demonstrar, não para uso real. Se usar, rode com o `Dockerfile` do repositório, defina as variáveis acima (`PEGASUS_TRUST_PROXY=1`) e confirme os limites atuais no site do provedor.

## Lembretes

- Se outras pessoas usarem seu Pegasus, você guarda dados delas: avise, faça backup e mantenha o sistema atualizado.
- As mensagens de texto são cifradas no banco com `PEGASUS_MESSAGE_KEY`; quem tiver o servidor **e** a chave consegue lê-las. Não é criptografia ponta a ponta.
