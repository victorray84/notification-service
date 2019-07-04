import Joi from '@hapi/joi'
import {
  AUTH_SCOPES,
  NETWORK_MAINNET,
  ALLOWED_NETWORKS,
  POSTGRES_UNIQUE_VIOLATION,
} from '../constants'
import Boom from '@hapi/boom'

const subscriptions = {
  name: 'subscriptions',
  version: '1.0.0',
  register: async function(server, options) {
    server.dependency(['web3', 'database', 'apm'])

    server.route(routes)
  },
}

export default subscriptions

const routes = [
  {
    method: 'GET',
    path: '/subscriptions',
    handler: getSubscriptions,
    options: { auth: AUTH_SCOPES.API },
  },
  {
    method: 'POST',
    path: '/subscription',
    handler: createSubscription,
    options: {
      auth: AUTH_SCOPES.API,
      validate: {
        failAction: (request, h, err) => {
          // show validation errors to user https://github.com/hapijs/hapi/issues/3706
          throw err
        },
        payload: {
          // name of the app/APM repository
          // TODO: event hash and contractAddress should be enough
          // TODO: remove appName and derive from contract
          appName: Joi.string().required(),
          eventName: Joi.string().required(),
          contractAddress: Joi.string().required(),
          network: Joi.any().valid(...ALLOWED_NETWORKS),
        },
      },
    },
  },
  {
    method: 'DELETE',
    path: '/subscriptions/{subscriptionId}',
    handler: deleteSubscription,
    options: {
      auth: AUTH_SCOPES.API,
      validate: {
        params: {
          subscriptionId: Joi.number().required(),
        },
      },
    },
  },
]

async function getSubscriptions(request, h) {
  const { db } = request.server.app
  const { userId } = request.auth.credentials

  try {
    const userSubscriptions = await db('subscriptions')
      .select(
        'eventsources.contract_address as contractAddress',
        'eventsources.event_name as eventName',
        'eventsources.network as network',
        'subscriptions.subscription_id as subscriptionId',
        'subscriptions.created_at as createdAt'
      )
      .join(
        'eventsources',
        'eventsources.eventsource_id',
        '=',
        'subscriptions.eventsource_id'
      )
      .where({ user_id: userId })
    return h.response(userSubscriptions)
  } catch (error) {
    request.log('error', `Failed getting subscriptions: ${error.message}`)
    return Boom.badImplementation()
  }
}

async function createSubscription(request, h) {
  const { db } = request.server.app
  const { userId } = request.auth.credentials
  const { eventName, contractAddress, appName } = request.payload
  const network = request.payload.network || NETWORK_MAINNET
  try {
    // get latest block and abi for the app
    const [latestBlock, abi] = await Promise.all([
      request.server.app.getLatestBlock(),
      request.server.app.getAbiFromApmServe(appName),
    ])

    const [eventsource] = await db('eventsources')
      .select('eventsource_id')
      .where({
        contract_address: contractAddress,
        event_name: eventName,
        network,
      })

    if (eventsource) {
      // event source exists. Just persist subscription
      const eventsourceId = eventsource.eventsource_id
      const subscriptionId = await insertSubscription({
        db,
        eventsourceId,
        userId,
        latestBlock,
      })

      return h.response({ subscriptionId: subscriptionId }).code(201)
    }

    // eventsource doesn't exists. Create eventsource and subscription in a transaction
    const subscriptionId = await db.transaction(async trx => {
      const eventsourceId = await trx('eventsources')
        .insert({
          contract_address: contractAddress,
          app_name: appName,
          event_name: eventName,
          network,
          abi: JSON.stringify(abi),
          from_block: latestBlock,
        })
        .returning('eventsource_id')
        .then(([id]) => id)

      return insertSubscription({
        db: trx,
        eventsourceId,
        userId,
        latestBlock,
      })
    })
    // transcation was success and automatically committed
    return h.response({ subscriptionId: subscriptionId }).code(201)
  } catch (error) {
    // If the transaction failed it will rolled back automatically
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      // 23505 is postgres's internal code for `unique_violation`.
      throw Boom.conflict('Subscription already exists')
    }
    request.log('error', error)
    throw Boom.badImplementation()
  }
}

const insertSubscription = async ({
  db,
  eventsourceId,
  userId,
  latestBlock,
}) => {
  return db('subscriptions')
    .insert({
      eventsource_id: eventsourceId,
      user_id: userId,
      join_block: latestBlock,
    })
    .returning('subscription_id')
    .then(([id]) => id)
}

async function deleteSubscription(request, h) {
  const { db } = request.server.app
  const { userId } = request.auth.credentials
  const { subscriptionId } = request.params

  try {
    const deleteCount = await db('subscriptions')
      .where({
        // userId is added to ensure only rows owned by user can be deleted
        user_id: userId,
        subscription_id: subscriptionId,
      })
      .delete()

    return h.response(deleteCount).code(200)
  } catch (error) {
    request.log('error', `Failed to create subscription: ${error.message}`)
    return Boom.badImplementation()
  }
}