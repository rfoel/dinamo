import type {
  AttributeValue,
  DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import camelcase from 'camelcase'

import logger from './logger'

const options: DynamoDBClientConfig =
  process.env.STAGE === 'prod'
    ? {
        logger,
      }
    : {
        region: 'local',
        endpoint: 'http://localhost:8000',
        logger,
      }

const client = new DynamoDBClient(options)

const dynamoDB = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})

export type Entity = {
  source: string
  target: string
  id: string
  createdAt: number
  updatedAt: number
}

export type Optional<Type, Key extends keyof Type> = Omit<Type, Key> &
  Partial<Pick<Type, Key>>

type Put = {
  item: Record<string, any>
}

type Update = {
  item: Record<string, any>
  key: Record<string, any>
}

type Query = {
  indexName?: string
  key: Record<string, any>
  query?: Record<string, any>
  limit?: number
  scanIndexForward?: boolean
  exclusiveStartKey?: Record<string, AttributeValue>
  recursive?: boolean
  items?: unknown[]
  filterDeleted?: boolean
}

type Get = {
  key: Record<string, any>
}

type BatchGet = {
  keys: Record<string, string>[]
}

type Scan = {
  exclusiveStartKey?: Record<string, AttributeValue>
  query?: Record<string, any>
  recursive?: boolean
  items?: unknown[]
  filterDeleted?: boolean
}

type Delete = {
  key: Record<string, any>
}

const buildExpressionAttributeNames = (
  input?: Record<
    string,
    | string
    | number
    | Record<string, string | number | { between: [number, number] }>
  >,
): Record<string, string> | undefined => {
  if (!input) return undefined
  return Object.keys(input).reduce(
    (acc, key) => ({
      ...acc,
      [`#${key}`]: key,
    }),
    {},
  )
}

const buildUpdateExpression = (
  input: Record<
    string,
    | string
    | number
    | Record<string, string | number | { between: [number, number] }>
  >,
): string => {
  return `set ${Object.keys(input)
    .map(key => `#${camelcase(key)} = :${camelcase(key)}`)
    .join(', ')}`
}

const buildExpressionAttributeValues = (
  input?: Record<
    string,
    | string
    | number
    | Record<string, string | number | { between: [number, number] }>
  >,
): Record<string, any> | undefined => {
  if (!input) return undefined

  return Object.entries(input).reduce((acc, [key, value]) => {
    if (
      typeof value === 'object' &&
      ['beginsWith', 'or', 'lt', 'lte', 'gte'].includes(Object.keys(value)[0])
    ) {
      return {
        ...acc,
        [`:${key}`]: value[Object.keys(value)[0]],
      }
    } else if (
      typeof value === 'object' &&
      value.between &&
      Array.isArray(value.between)
    ) {
      const [value0, value1] = value.between
      return {
        ...acc,
        [`:${key}0`]: value0,
        [`:${key}1`]: value1,
      }
    }
    return {
      ...acc,
      [`:${key}`]: value,
    }
  }, {})
}

export const buildFilterExpression = (
  input?: Record<string, unknown>,
): string | undefined =>
  input && Object.keys(input).length
    ? `${Object.entries(input)
        .map(([key, value]) => {
          if (typeof value === 'object') {
            const keys = Object.keys(value as object)
            if (keys[0] === 'beginsWith') return `begins_with(#${key}, :${key})`
            if (keys[0] === 'lt') return `#${key} < :${key}`
            if (keys[0] === 'lte') return `#${key} <= :${key}`
            if (keys[0] === 'gte') return `#${key} >= :${key}`
            if (keys[0] === 'between')
              return `#${key} BETWEEN :${key}0 AND :${key}1`
            if (keys[0] === 'or')
              return `#${key} = :${key}0 OR #${key} = :${key}1`
            return keys
              .map(k => `#${key}.#${k} = :${camelcase(`${key}.${k}`)}`)
              .join(' AND ')
          }
          return `#${key} = :${key}`
        })
        .join(' AND ')}`
    : undefined

const makeResult = <Type>(result: Entity) => {
  if (result && result.source === result.target)
    result.id = getIdFromKey(result.source)
  return result as Entity & Type
}

const makeResults = <Type>(result: Entity[]) =>
  result.map(item => {
    if (item?.source === item?.target) {
      item.id = getIdFromKey(item.source)
    }
    return item
  }) as (Entity & Type)[]

const getIdFromKey = (source: Entity['source']) => {
  const [, ...ids] = source.split(/#/)
  return ids.join('#')
}

type DinamoConfig = {
  tableName: string
}

export default (config: DinamoConfig) => {
  const { tableName } = config

  const put = ({ item }: Put) => {
    item.createdAt = +new Date()
    return dynamoDB.send(new PutCommand({ TableName: tableName, Item: item }))
  }

  const update = ({ key, item }: Update) => {
    item.updatedAt = +new Date()
    return dynamoDB.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: buildUpdateExpression(item),
        ExpressionAttributeNames: buildExpressionAttributeNames(item),
        ExpressionAttributeValues: buildExpressionAttributeValues(item),
      }),
    )
  }

  const query = async <Type>({
    indexName,
    key,
    limit,
    query: input,
    scanIndexForward,
    exclusiveStartKey,
    items = [],
    recursive,
    filterDeleted = true,
  }: Query): Promise<{
    data: (Entity & Type)[]
    lastEvaluatedKey?: Record<string, string>
  }> => {
    const expressionAttributeNames = buildExpressionAttributeNames({
      ...key,
      ...input,
    })

    const expressionAttributeValues = buildExpressionAttributeValues({
      ...key,
      ...input,
    })

    const keyConditionExpression = buildFilterExpression(key)
    let filterExpression = buildFilterExpression(input)

    if (expressionAttributeNames && filterDeleted) {
      expressionAttributeNames['#deletedAt'] = 'deletedAt'
      filterExpression = filterExpression
        ? `${filterExpression} AND attribute_not_exists(#deletedAt)`
        : 'attribute_not_exists(#deletedAt)'
    }
    const { Items, LastEvaluatedKey } = await dynamoDB.send(
      new QueryCommand({
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        KeyConditionExpression: keyConditionExpression,
        FilterExpression: filterExpression,
        ScanIndexForward: scanIndexForward,
        TableName: tableName,
        IndexName: indexName,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    if (recursive && LastEvaluatedKey) {
      items.push(...items)
      return query<Type>({
        exclusiveStartKey: LastEvaluatedKey,
        key,
        items,
        query: input,
        recursive,
        indexName,
        filterDeleted,
      })
    }

    return {
      data: makeResults<Type>(Items as unknown as Entity[]),
      lastEvaluatedKey: LastEvaluatedKey,
    }
  }

  const get = async <Type>({ key }: Get) => {
    const { Item } = await dynamoDB.send(
      new GetCommand({ TableName: tableName, Key: key }),
    )

    return makeResult<Type>(Item as unknown as Entity)
  }

  const batchGet = async <Type>({ keys }: BatchGet) => {
    const { Responses } = await dynamoDB.send(
      new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: keys } },
      }),
    )

    if (!Responses) return []

    return makeResults<Type>(
      Object.values(Responses).flat() as unknown as Entity[],
    )
  }

  const scan = async <Type>({
    exclusiveStartKey,
    items = [],
    query,
    recursive,
    filterDeleted = true,
  }: Scan): Promise<(Entity & Type)[]> => {
    const expressionAttributeNames = buildExpressionAttributeNames(query)
    const expressionAttributeValues = buildExpressionAttributeValues(query)
    let filterExpression = buildFilterExpression(query)

    if (expressionAttributeNames && filterDeleted) {
      expressionAttributeNames['#deletedAt'] = 'deletedAt'
      filterExpression = filterExpression
        ? `${filterExpression} AND attribute_not_exists(#deletedAt)`
        : 'attribute_not_exists(#deletedAt)'
    }

    const { Items, LastEvaluatedKey } = await dynamoDB.send(
      new ScanCommand({
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        FilterExpression: filterExpression,
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    if (recursive && LastEvaluatedKey) {
      items.push(...items)
      return scan<Type>({
        exclusiveStartKey: LastEvaluatedKey,
        items,
        query,
        recursive,
      })
    }

    return makeResults<Type>(Items as unknown as Entity[]) as (Entity & Type)[]
  }

  const deleteItem = async ({ key }: Delete) => {
    return dynamoDB.send(new DeleteCommand({ TableName: tableName, Key: key }))
  }

  return {
    batchGet,
    delete: deleteItem,
    get,
    put,
    query,
    scan,
    update,
  }
}
