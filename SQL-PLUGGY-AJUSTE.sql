-- Execute uma vez no SQL Editor do Supabase antes do primeiro teste do botão Conectar banco.
-- A tabela pluggy_items usa uma coluna identity; este grant permite gerar o ID automático.
grant usage, select on sequence public.pluggy_items_id_seq to authenticated;
