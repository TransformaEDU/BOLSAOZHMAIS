/**
 * Teste do módulo de atribuição de campanha que roda no NAVEGADOR.
 * Rodar:  node api/atribuicao.test.js
 *
 * api/lead.test.js cobre o servidor. Este cobre o cliente, que é onde moram as
 * regras que erram em silêncio: primeiro toque imutável, macro de anúncio não
 * substituída, `fbclid=fbclid` do template e parâmetro repetido. Nenhuma delas
 * aparece para quem preenche o formulário — o lead entra, só com a origem
 * errada ou perdida.
 *
 * O código testado é extraído do index.html e executado num navegador falso,
 * de propósito: assim o teste exercita exatamente o que vai ao ar, em vez de
 * uma cópia que pode divergir da página.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'index.html');

function extrair() {
  const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
  const abre = '  const atribuicao = (() => {';
  const fecha = '\n  })();';
  const inicio = html.indexOf(abre);
  const fim = html.indexOf(fecha, inicio);
  if (inicio < 0 || fim < 0) throw new Error('não encontrei o módulo de atribuição no index.html');
  return html.slice(inicio, fim + fecha.length);
}

const CODIGO = extrair();

/** Executa o módulo para uma sequência de visitas, num navegador falso. */
function visitar(buscas, armazem, storageQuebrado) {
  let ultimo = null;
  for (const busca of buscas) {
    const sandbox = {
      URLSearchParams,
      location: { search: busca },
      localStorage: storageQuebrado
        ? {
            getItem() { throw new Error('storage bloqueado'); },
            setItem() { throw new Error('storage bloqueado'); },
          }
        : {
            getItem: (k) => (k in armazem ? armazem[k] : null),
            setItem: (k, v) => { armazem[k] = String(v); },
          },
      resultado: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(CODIGO + '\nresultado = atribuicao;', sandbox);
    ultimo = sandbox.resultado;
  }
  return ultimo;
}

/* deepStrictEqual não serve para objetos vindos do sandbox: eles têm outro
   Object.prototype e a comparação falha mesmo quando o conteúdo é igual. */
const vazio = (obj, msg) => assert.strictEqual(Object.keys(obj).length, 0, msg);

{
  const armazem = {};
  const r = visitar([
    '?utm_source=google&utm_medium=cpc&utm_campaign=marca',
    '',
    '?utm_source=ig&utm_medium=paid_social&utm_campaign=bolsao',
  ], armazem);

  assert.strictEqual(r.campos.first_utm_source, 'google', 'primeiro toque é imutável');
  assert.strictEqual(r.campos.first_utm_campaign, 'marca');
  assert.strictEqual(r.campos.first_utm_medium, 'cpc');
  assert.strictEqual(r.campos.last_utm_source, 'ig', 'último toque acompanha a visita nova');
  assert.strictEqual(r.campos.last_utm_campaign, 'bolsao');
  assert.strictEqual(r.campos.last_utm_medium, 'paid_social');
  assert.strictEqual(r.utm.utm_source, 'ig', 'o contrato antigo leva a última origem');
  assert.ok(Object.keys(armazem).length === 1, 'grava uma chave própria no localStorage');
  console.log('ok  primeiro toque imutável, último atualizado, visita direta não apaga');
}

{
  vazio(visitar(['?utm_source={{site_source_name}}&utm_medium=paid_social&fbclid=fbclid'], {}).campos,
    'link do gerenciador com macro é ignorado por inteiro');
  vazio(visitar(['?utm_source=%7B%7Bsite_source_name%7D%7D&utm_medium=paid_social'], {}).campos,
    'macro percent-encoded também é ignorada');
  console.log('ok  macro não substituída não ocupa o primeiro toque');
}

{
  const r = visitar([
    '?utm_source=google&utm_campaign=marca',
    '?utm_source={{site_source_name}}&utm_medium=paid_social',
  ], {});
  assert.strictEqual(r.campos.last_utm_source, 'google', 'teste manual não sobrescreve origem real');
  console.log('ok  visita de teste não estraga atribuição já gravada');
}

{
  const r = visitar(['?fbclid=fbclid&utm_source=ig&fbclid=TOKEN_REAL'], {});
  assert.strictEqual(r.campos.last_fbclid, 'TOKEN_REAL', 'parâmetro repetido: o último aproveitável vence');
  assert.strictEqual(r.campos.first_utm_source, 'ig');
  vazio(visitar(['?fbclid=fbclid'], {}).campos, 'fbclid=fbclid sozinho não vira atribuição');
  console.log('ok  fbclid=fbclid descartado, token real preservado');
}

{
  const r = visitar(['?msclkid=abc&utm_term=' + 'A'.repeat(400)], {});
  assert.strictEqual(r.campos.last_msclkid, 'abc', 'msclkid é capturado');
  assert.strictEqual(r.campos.last_utm_term.length, 200, 'valor longo é cortado, não descartado');
  console.log('ok  msclkid capturado e valor longo cortado em 200');
}

{
  const r = visitar(['?utm_source=ig'], {}, true);
  assert.strictEqual(r.campos.last_utm_source, 'ig', 'aba anônima continua atribuindo nesta visita');
  console.log('ok  navegador sem storage não quebra o formulário');
}

{
  /* Validade de 30 dias (pedido da TI em 04/11/2026): envelhece o registro
     gravado e volta sem UTM. */
  const envelhecer = (armazem, diasFirst, diasLast) => {
    const chave = Object.keys(armazem)[0];
    const r = JSON.parse(armazem[chave]);
    r.first.capturadoEm = new Date(Date.now() - diasFirst * 864e5).toISOString();
    r.last.capturadoEm = new Date(Date.now() - diasLast * 864e5).toISOString();
    armazem[chave] = JSON.stringify(r);
  };

  let armazem = {};
  visitar(['?utm_source=antiga', '?utm_source=recente'], armazem);
  envelhecer(armazem, 40, 10);
  let r = visitar([''], armazem);
  assert.strictEqual(r.campos.first_utm_source, undefined, 'toque com mais de 30 dias sai');
  assert.strictEqual(r.campos.last_utm_source, 'recente', 'toque com menos de 30 dias fica');

  armazem = {};
  visitar(['?utm_source=a'], armazem);
  envelhecer(armazem, 31, 31);
  r = visitar([''], armazem);
  assert.strictEqual(Object.keys(r.campos).length, 0, 'tudo vencido = sem origem');
  r = visitar(['?utm_source=nova'], armazem);
  assert.strictEqual(r.campos.first_utm_source, 'nova', 'depois de vencer, a visita nova vira o primeiro toque');

  armazem = {};
  visitar(['?utm_source=a'], armazem);
  envelhecer(armazem, 29, 29);
  r = visitar([''], armazem);
  assert.strictEqual(r.campos.last_utm_source, 'a', '29 dias ainda vale');
  console.log('ok  origem vale 30 dias');
}

console.log('\ntodos os testes passaram');
