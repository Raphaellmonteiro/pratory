# Gestão de Delivery + Ganhos — como encaixar no seu projeto

Arquivos (copie mantendo as pastas):

| Arquivo | Vai em |
|---|---|
| `src/db/migrations/gestaoDelivery.ts` | `src/db/migrations/` |
| `src/routes/adminGestaoDelivery.ts` | `src/routes/` |
| `src/shared/AdminGestaoDelivery.tsx` | `src/shared/` |
| `seed_planilha.sql` | rode uma vez no banco (importa a planilha) |

São **4 pontos de contato** com o código existente:

## 1) `src/db.ts` — registrar a migration
Junto das outras (perto de `ensureGarconsSchema`):
```ts
const { ensureGestaoDeliverySchema } = await import('./db/migrations/gestaoDelivery');
await ensureGestaoDeliverySchema();
```

## 2) `src/routes/admin.ts` — registrar as rotas
No topo: `import { registerGestaoDeliveryRoutes } from './adminGestaoDelivery';`
Depois de `admin.use(authenticateAdmin);` (já protege com JWT de admin):
```ts
registerGestaoDeliveryRoutes(admin);
```

## 3) `src/routes/admin.ts` — parar de contar "editar vencimento" como receita (importante)
Hoje o `PUT /clientes/:id` insere em `renovacoes` **sempre que o plano ou o vencimento muda**,
mesmo que ninguém tenha pago. Isso infla `faturamento_mensal`. Troque o INSERT (linha ~623) por:
```ts
'INSERT INTO renovacoes (cliente_id,plano,valor,vencimento_anterior,novo_vencimento,origem) VALUES (?,?,?,?,?,\'edicao\')'
```
e em `GET /financeiro` (linha ~975) filtre: `FROM renovacoes WHERE origem IS DISTINCT FROM 'edicao' GROUP BY mes ...`.
A partir daí, receita de software = botão **“Recebi”** (rota `POST /gestao-delivery/software/:id/pagamento`),
que grava valor, forma, data e já renova o vencimento. (Registros antigos continuam contando; só os novos "edição" são ignorados.)

## 4) `src/shared/AdminPanel.tsx` — nova aba “Gestão”
```tsx
import AdminGestaoDelivery from './AdminGestaoDelivery';
// linha 161: acrescente 'gestao' na união de tipos de activeTab

// no menu lateral, junto do botão Financeiro:
<button onClick={() => { setActiveTab('gestao'); setAdminNavOpen(false); }}
  className={`w-full flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-xl font-medium transition-all ${activeTab === 'gestao' ? 'bg-emerald-600 text-white shadow-lg' : 'text-zinc-300 hover:bg-zinc-800/60'}`}>
  <Wallet size={18} /> Gestão & Ganhos
</button>

// no conteúdo, junto das outras abas:
<div className={activeTab !== 'gestao' ? 'hidden' : ''}>
  {activeTab === 'gestao' && <AdminGestaoDelivery token={token} onAuthError={handleAuthError} />}
</div>
```
(`Wallet` vem do `lucide-react`; adicione ao import se ainda não existir.)

## Importar a planilha
Suba o servidor uma vez (cria as tabelas) e rode `seed_planilha.sql`. Ele traz os 3 restaurantes e as 12 semanas.
As senhas que estavam nas observações **não foram importadas**.

## Regras de cálculo (idênticas à planilha)
`comissão = líquido dono × (% meu + % parceiro)` · `repasse = líquido × % parceiro` · `meu = comissão − repasse`.
Diferenças propositais: arredonda em centavos por semana; os % ficam **congelados em cada semana**
(mudar a taxa do restaurante não reescreve o histórico; há um checkbox para aplicar às semanas ainda não pagas).

## Visual
O módulo segue a identidade do Pratori: fundo claro, texto `#3f3e3e`, vermelho `#EA1D2C` como destaque
(sem verde esmeralda e sem tokens do tema antigo). É autossuficiente: **não usa** `Card`, `Modal`
nem `fieldStyles` do projeto, então não depende do tema escuro do admin e não é afetado pelas regras
globais `.admin-dark` (`thead`, `.bg-white`, `input[type=text]`). Dentro do admin escuro ele aparece como
um painel claro; as cores ficam todas no objeto `C` e nas classes `bg-[#...]` do próprio arquivo.
Prévias em `previa/`.

## Testado
Backend rodado contra um Postgres real em memória (PGlite): cadastro, upsert semanal, snapshot de %, fechamento,
baixa em lote, repasse, resumo, ganhos, pagamento de software e o seed (totais conferem com o Dashboard da planilha).
O componente React passa no `tsc --strict` e foi renderizado no Chromium (desktop e celular, 390px) com os dados
da planilha, dentro de um shell escuro simulado com as suas regras globais de CSS. Falta só ver dentro do seu
AdminPanel real.
