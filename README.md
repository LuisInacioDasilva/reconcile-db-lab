# Reconcile DB Lab

Este projeto parte de uma dor recorrente em integrações: um sistema informa que enviou um evento, outro mostra um estado diferente e ninguém consegue reconstruir o caminho. O banco aqui é o centro da solução. Modelei a entrada, o estado consolidado e a trilha de decisão separadamente para que repetição, ordem errada e divergência não virem atualização silenciosa.

## O que dá para ver

`pnpm demo` gera `dist/index.html`, um relatório local responsivo com pedidos, origens, eventos aplicados e rejeições. Os dados são sintéticos. Não há chave de API, conta em nuvem ou serviço pago. O arquivo pode ser aberto diretamente no navegador.

## Rodar

Requisitos: Node.js 20+ e pnpm 11. A demonstração usa [PGlite](https://pglite.dev/docs/), uma distribuição PostgreSQL em WebAssembly que roda sem servidor; os mesmos scripts SQL podem ser executados em PostgreSQL convencional.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm demo
```

Abra `dist/index.html`. Em Windows, `Start-Process dist/index.html` também funciona. Para usar PostgreSQL instalado, aplique `sql/001_up.sql` e depois `sql/seed.sql` com `psql -v ON_ERROR_STOP=1 -f ...` em uma **base descartável**.

## Modelo e decisões

| Objeto | Responsabilidade |
| --- | --- |
| `sources` | Identidade única de cada sistema de origem. |
| `orders` | Estado consolidado, valor em centavos e versão. |
| `inbox_events` | Entrada original em JSONB, chave única `(source_id, external_event_id)` e fingerprint. |
| `transitions` | Decisão auditável: estado anterior, solicitado, aceito/rejeitado e motivo. |
| `ingest_event` | Uma transação: deduplica, trava a linha do pedido, valida o fluxo e registra a decisão. |
| `source_health` e `order_snapshot` | Consultas de operação sem precisar reconstruir regras na aplicação. |
| `order_integrity` | Detecta versão ou estado alterado diretamente sem transição de auditoria correspondente. |

O `ON CONFLICT DO NOTHING` só aparece onde a `UNIQUE` correspondente já existe. Replay idêntico retorna `duplicate`; o mesmo ID com conteúdo diferente falha. Evento fora de ordem permanece no inbox e gera uma transição rejeitada, sem mudar o pedido. A trilha tem gatilhos que impedem `UPDATE` e `DELETE`. Para um volume grande, eu particionaria `inbox_events` por período e revisaria o plano das visões com `EXPLAIN (ANALYZE, BUFFERS)` sobre dados representativos; não faço essa otimização sem medir.

`source_health` agrega pedidos e eventos separadamente antes do join; isso evita multiplicação de linhas entre duas relações um-para-muitos. `order_integrity` não corrige divergências automaticamente: ela expõe alteração de estado ou versão sem evento correspondente, para investigação. Em um banco real, a função de ingestão teria permissão de escrita dedicada e usuários de relatório receberiam apenas `SELECT` nas views.

## Testes

`pnpm test` cobre reexecução do seed, replay, conflito de payload, transição fora de ordem, constraints, imutabilidade, reconciliação das visões e rollback. Não substitui teste de carga ou de concorrência com PostgreSQL servidor: PGlite usa uma instância embutida e o comportamento de múltiplas conexões precisa de um ambiente próprio.

## Deploy e rollback

Em um PostgreSQL real, aplique `001_up.sql` em transação antes de liberar o produtor de eventos; conecte a aplicação com usuário de privilégios mínimos e restrinja acesso direto às tabelas de auditoria. Observe rejeições na visão `source_health`. O rollback está em `001_down.sql`, mas **remove todo o schema e seus dados**. Antes de executá-lo fora de ambiente descartável, exporte os dados, interrompa a ingestão e valide a recuperação em staging. Não há migração automática em produção neste repositório.

---

<p align="center"><a href="https://github.com/LuisInacioDasilva"><img src="https://avatars.githubusercontent.com/u/88007376?v=4" width="82" height="82" alt="Foto de Luis da Silva" style="border-radius:50%"></a></p>
<p align="center"><strong>Desenvolvido por Luis da Silva</strong><br>Back-end, dados, integrações e automação em produção.</p>
