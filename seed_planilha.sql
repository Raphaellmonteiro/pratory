-- Importa os 3 restaurantes e todas as semanas da planilha CONTROLE_RESTAURANTES_DEFINITIVA_v4.
-- Rode DEPOIS que a migration criou as tabelas (suba o servidor uma vez). É idempotente por nome.
-- Obs.: senhas que estavam nas observações da planilha NÃO foram importadas de propósito.
-- Semanas "Pago" entram com repasse_pago = TRUE (a planilha considerava o parceiro quitado junto).

BEGIN;

INSERT INTO gd_estabelecimentos
  (nome, razao_social, documento_tipo, documento_numero, responsavel, whatsapp, email, cidade,
   pix_tipo, pix_chave, pix_titular, apps, pct_meu, tem_parceiro, parceiro_nome, pct_parceiro, inicio_em, observacoes)
SELECT * FROM (VALUES
  ('Budega da Sonia', NULL, 'CNPJ', '64782668000110', 'Maria Sonia da Silva Teotônio', '82996918296',
   'soniateotonio15@gmail.com', NULL, NULL, '10409969494', 'Maria Sonia da Silva Teotônio',
   ARRAY['99food','ifood'], 4.0, TRUE, 'Parceiro', 2.0, DATE '2026-09-01', 'CPF do responsável: 26275609800'),
  ('AcaiDera Feitosa', NULL, 'CNPJ', '62279588000111', 'Kleiton Vitor Feliciano da Silva', '82998187631',
   'celicleidem@gmail.com', NULL, NULL, NULL, NULL,
   ARRAY['99food','ifood'], 10.0, FALSE, NULL, 0.0, DATE '2026-09-14', 'CPF 15141954455 · Conta Santander 99food: Ag 2990 / Cc 15.057933-5'),
  ('Cantinho Arretado', NULL, 'CNPJ', '56182802000114', 'Suene Aline Gomes de Bulhões', '82999649036',
   'cantinhoarretado2026@gmail.com', NULL, NULL, NULL, NULL,
   ARRAY['99food','ifood'], 7.5, FALSE, NULL, 0.0, DATE '2026-09-28', 'CPF do responsável: 87032864449')
) AS v(nome, razao_social, documento_tipo, documento_numero, responsavel, whatsapp, email, cidade,
       pix_tipo, pix_chave, pix_titular, apps, pct_meu, tem_parceiro, parceiro_nome, pct_parceiro, inicio_em, observacoes)
WHERE NOT EXISTS (SELECT 1 FROM gd_estabelecimentos e WHERE e.nome = v.nome);

INSERT INTO gd_lancamentos
  (estabelecimento_id, semana_inicio, semana_fim, valor_99food, valor_ifood, pct_meu_snap, pct_parceiro_snap,
   status, data_pagamento, repasse_pago)
SELECT e.id, v.ini::date, v.fim::date, v.v99, v.vif, e.pct_meu, e.pct_parceiro, v.status, v.dpag::date,
       (v.status = 'pago' AND e.pct_parceiro > 0)
FROM (VALUES
  ('Budega da Sonia',   '2026-09-01','2026-09-06',   54.02, 105.81, 'pago',       '2026-09-09'),
  ('Budega da Sonia',   '2026-09-07','2026-09-13', 4677.08, 184.85, 'pago',       NULL),
  ('Budega da Sonia',   '2026-09-14','2026-09-20', 6758.27, 314.39, 'pago',       NULL),
  ('Budega da Sonia',   '2026-09-21','2026-09-27', 7101.56, 315.28, 'pago',       NULL),
  ('Budega da Sonia',   '2026-09-28','2026-10-04', 6343.46, 290.05, 'pago',       NULL),
  ('Budega da Sonia',   '2026-10-05','2026-10-11', 6582.84, 162.26, 'aguardando', NULL),
  ('AcaiDera Feitosa',  '2026-09-14','2026-09-20',    0.00,  79.46, 'aguardando', NULL),
  ('AcaiDera Feitosa',  '2026-09-21','2026-09-27',  294.11,  51.25, 'aguardando', NULL),
  ('AcaiDera Feitosa',  '2026-09-28','2026-10-04', 1648.95,  27.63, 'pago',       NULL),
  ('AcaiDera Feitosa',  '2026-10-05','2026-10-11', 1420.93,  16.05, 'em_andamento', NULL),
  ('Cantinho Arretado', '2026-09-28','2026-10-04',  616.20,  22.55, 'aguardando', NULL),
  ('Cantinho Arretado', '2026-10-05','2026-10-11', 4945.51,  12.40, 'aguardando', NULL)
) AS v(nome, ini, fim, v99, vif, status, dpag)
JOIN gd_estabelecimentos e ON e.nome = v.nome
ON CONFLICT (estabelecimento_id, semana_inicio) DO NOTHING;

COMMIT;
