# Robô do ComboTrialz (GitHub Actions)

Roda sozinho nos servidores do GitHub, de graça, sem ninguém com o app aberto:

- **a cada 3 h** pesquisa notícias de fighting games no Gemini (com Google Search); na rodada seguinte
  verifica e publica direto em **Novidades → Cenário** (coleção `news`), com o link real da matéria;
- **a cada 15 min** confere os canais do YouTube cadastrados no app (Ajustes → Canais do YouTube);
- **importa os relatórios de combos do Claude** assim que chegam em `relatorios/` (mesma regra do botão
  "Importar relatório" do app);
- grava `estado/estado.json` (patch atual, combos e notícias que já existem) para a pesquisa do Claude não repetir;
- **manda push** para os celulares inscritos: notícias, combos e vídeos novos.

A pesquisa de combos do Claude roda como rotina agendada do Claude Code com o prompt de `rotina-claude.md`:
ela lê `estado/estado.json`, salva `relatorios/relatorio-AAAA-MM-DD.json` e dá push. O robô faz o resto.

O plano grátis do Gemini dá cerca de 20 pedidos por dia por modelo. Com busca a cada 3 h o robô gasta ~16.
Para mudar: Settings → Secrets and variables → Actions → aba **Variables** → `HORAS_ENTRE_BUSCAS` (ex.: `4`).

## Configurar (uma vez, só pelo site do GitHub)

1. Crie uma conta em https://github.com (grátis).
2. **New repository** → nome `combotrialz-robo` → **Public** → *Create repository*.
   Público é grátis sem limite de minutos. O código não tem nenhuma chave; as chaves ficam nos Secrets, que ninguém vê.
3. Na página do repositório: **uploading an existing file** → abra a pasta `combotrialz-robo-github`,
   selecione **tudo** que está dentro dela (Ctrl+A, inclusive a pasta `.github`) e arraste para a página → *Commit changes*.
   Confira depois se aparece a pasta `.github/workflows/robo.yml` no repositório.
   Se ela não subir, use **Add file → Create new file**, digite o nome `.github/workflows/robo.yml`
   e cole o conteúdo desse arquivo.
4. **Settings → Secrets and variables → Actions → New repository secret** e crie dois:
   - `GEMINI_API_KEY` → a chave do Gemini;
   - `FIREBASE_SERVICE_ACCOUNT` → todo o conteúdo do arquivo `.json` da conta de serviço
     (Firebase → ⚙️ Configurações do projeto → Contas de serviço → **Gerar nova chave privada**).
5. **Settings → Actions → General → Workflow permissions** → *Read and write permissions* → Save.
   (Serve só para o robô fazer um commit vazio por mês; sem isso o GitHub desliga agendamentos parados há 60 dias.)
6. Aba **Actions** → *Robô ComboTrialz* → **Run workflow**. Em 1 minuto aparece o resultado;
   clique na execução → `rodar` → passo `node robo.mjs` para ver o que ele fez.

Depois disso ele roda sozinho. Se der erro, o GitHub manda e-mail.

## O que aparece no log

```
relatórios: relatorio-2026-10-17.json: 4 combo(s) novo(s), 0 atualizado(s), 5 notícia(s)
notícias: 3 nova(s), 0 publicada(s), 0 descartada(s)
vídeos: 1 novo(s)
push: 1 aviso(s), 12 entrega(s)
estado: 812 combos, 140 notícias
```

`Gemini ... 429` = a cota grátis do dia acabou; ele tenta de novo na próxima rodada.

## Testar no computador (opcional)

```
npm install
node teste.mjs
```
