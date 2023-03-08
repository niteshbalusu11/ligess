const fastify = require('fastify')({ logger: true })
const { bech32 } = require('bech32')
const crypto = require('crypto')
const {authenticatedLndGrpc, createInvoice} = require('ln-service');
const { getLnClient } = require('./lnClient')
const { getNostrPubKey, verifyZapRequest, storePendingZapRequest, handleInvoiceUpdate } = require('./nostr')

const _username = process.env.LIGESS_USERNAME
const _domain = process.env.LIGESS_DOMAIN
const _identifier = `${_username}@${_domain}`
const _lnurlpUrl = `https://${_domain}/.well-known/lnurlp/${_username}`
const _metadata = [['text/identifier', _identifier], ['text/plain', `Satoshis to ${_identifier}`]]
const _nostrPubKey = getNostrPubKey()

const unaWrapper = getLnClient()

fastify.get('/', async (request, reply) => {
  // TODO Render html instead of JSON
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET");

  fastify.log.warn('Unexpected request to root. When using a proxy, make sure the URL path is forwarded.')

  const words = bech32.toWords(Buffer.from(_lnurlpUrl, 'utf8'))
  return {
    lnurlp: bech32.encode('lnurl', words, 1023),
    decodedUrl: _lnurlpUrl,
    info: {
      title: 'Ligess: Lightning address personal server',
      source: 'https://github.com/dolu89/ligess',
    },
  }
})

fastify.get('/.well-known/lnurlp/:username', async (request, reply) => {
  try {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET");

    if (_username !== request.params.username) {
      const result = { status: 'ERROR', reason: 'Username not found' }
      reply.log.warn(result)
      reply.code(404).send(result)
      return
    }

    if (!request.query.amount) {
      const result = {
        status: 'OK',
        callback: _lnurlpUrl,
        tag: 'payRequest',
        maxSendable: 100000000,
        minSendable: 1000,
        metadata: JSON.stringify(_metadata),
        commentAllowed: 280,
      }
      if (_nostrPubKey) {
        result.allowsNostr = true
        result.nostrPubkey = _nostrPubKey
      }
      return result
    } else {
      const msat = request.query.amount

      if (isNaN(msat)) {
        const result = { status: 'ERROR', reason: 'Invalid amount specified' }
        request.log.warn(result)
        reply.code(400).send(result)
        return
      }

      const zapRequest = await verifyZapRequest(request.query.nostr, msat)
      
      const metadata = JSON.stringify(zapRequest ? zapRequest : _metadata)
      
      // const invoice = await unaWrapper.createInvoice({
      //   amountMsats: msat,
      //   descriptionHash: crypto
      //     .createHash('sha256')
      //     .update(metadata)
      //     .digest('hex')
      // })

      const {lnd} = authenticatedLndGrpc({cert: process.env.CERT, macaroon: process.env.MACAROON, socket: process.env.SOCKET});

      const invoice = await createInvoice({
        lnd,
        mtokens: msat,
        is_including_private_channels: true,
        description_hash: crypto
        .createHash('sha256')
        .update(metadata)
        .digest('hex')
      });

      console.log(invoice);

      if (zapRequest) storePendingZapRequest(invoice.payment, zapRequest, request.query.comment, request.log)

      return {
        status: 'OK',
        successAction: { tag: 'message', message: `Thank you for the ${zapRequest ? 'zap' : 'payment'}! --${_username}`},
        routes: [],
        pr: invoice.request,
        disposable: false,
      }
    }
  } catch (error) {
    console.error(error);
    const result = { status: 'ERROR', reason: `An error occured while getting invoice: ${error.message}` }
    request.log.warn(result)
    reply.code(400).send(result)
    return
  }
})

if (_nostrPubKey) {
  unaWrapper.watchInvoices().on('invoice-updated', (invoice) => handleInvoiceUpdate(invoice))
}

const start = async () => {
  try {
    await fastify.listen(
      process.env.PORT || 3000,
      process.env.HOST || '127.0.0.1'
    )
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

module.exports = { start }
