import type { AttributeValue } from '@aws-sdk/client-dynamodb'
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
import { Logger } from '@aws-sdk/types'
import camelcase from 'camelcase'

type Put = { item: Record<string, any> }

type Update = {
  item: Record<string, any>
  key: Record<string, any>
}

type Increment = {
  field: string
  key: Record<string, any>
  step?: number
}

type Query<Type> = {
  key: Record<string, any>
  indexName?: string
  query?: Record<string, any>
  limit?: number
  scanIndexForward?: boolean
  exclusiveStartKey?: Record<string, AttributeValue>
  recursive?: boolean
  items?: Type[]
  filterDeleted?: boolean
}

type Get = {
  key: Record<string, any>
}

type BatchGet = {
  keys: Record<string, string>[]
}

type Scan<Type> = {
  exclusiveStartKey?: Record<string, AttributeValue>
  query?: Record<string, any>
  recursive?: boolean
  items?: Type[]
  filterDeleted?: boolean
}

type Delete = {
  key: Record<string, any>
  soft?: boolean
}

const buildExpressionAttributeNames = (
  input?: Record<string, string | number | Record<string, string | number>>,
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
  input: Record<string, string | number | Record<string, string | number>>,
): string => {
  return `set ${Object.entries(input)
    .map(
      ([key, value]) =>
        `#${camelcase(key)} = ${
          typeof value === 'object' && Object.keys(value)[0] === 'increment'
            ? `#${camelcase(key)} +`
            : ''
        } :${camelcase(key)}`,
    )
    .join(', ')}`
}

const buildExpressionAttributeValues = (
  input?: Record<
    string,
    | string
    | number
    | Record<
        string,
        string | number | { between: [number, number] } | { increment: number }
      >
  >,
): Record<string, any> | undefined => {
  if (!input) return undefined

  return Object.entries(input).reduce((acc, [key, value]) => {
    if (
      typeof value === 'object' &&
      ['beginsWith', 'or', 'lt', 'lte', 'gte', 'increment'].includes(
        Object.keys(value)[0],
      )
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

export type DinamoConfig = {
  endpoint?: string
  logger?: Logger
  region?: string
  tableName: string
}

export default class Dinamo {
  client: DynamoDBClient
  dynamoDB: DynamoDBDocumentClient
  tableName: string

  constructor(config: DinamoConfig) {
    this.tableName = config.tableName

    this.client = new DynamoDBClient({
      endpoint: config.endpoint,
      logger: config.logger,
      region: config.region,
    })

    this.dynamoDB = DynamoDBDocumentClient.from(this.client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  async batchGet<Type>({ keys }: BatchGet) {
    const { Responses } = await this.dynamoDB.send(
      new BatchGetCommand({
        RequestItems: { [this.tableName]: { Keys: keys } },
      }),
    )

    if (!Responses) return []

    return Object.values(Responses).flat() as Type[]
  }

  async decrement<Type>({ key, field, step = 1 }: Increment) {
    return this.increment<Type>({ key, field, step: -Math.abs(step) })
  }

  async delete<Type>({ key, soft = true }: Delete) {
    const deletedAt = +new Date()
    if (soft) {
      return this.update<Type>({ key, item: { deletedAt } })
    }
    return this.dynamoDB.send(
      new DeleteCommand({ TableName: this.tableName, Key: key }),
    )
  }

  async get<Type>({ key }: Get) {
    const { Item } = await this.dynamoDB.send(
      new GetCommand({ TableName: this.tableName, Key: key }),
    )
    return Item as Type
  }

  async increment<Type>({ key, field, step = 1 }: Increment) {
    return this.update<Type>({ key, item: { [field]: { increment: step } } })
  }

  async put({ item }: Put) {
    item.createdAt = +new Date()
    return this.dynamoDB.send(
      new PutCommand({ TableName: this.tableName, Item: item }),
    )
  }

  async query<Type>({
    indexName,
    key,
    limit,
    query: input,
    scanIndexForward,
    exclusiveStartKey,
    items = [],
    recursive,
    filterDeleted = true,
  }: Query<Type>): Promise<{
    data: Type[]
    lastEvaluatedKey?: Record<string, string>
  }> {
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
    const { Items, LastEvaluatedKey } = await this.dynamoDB.send(
      new QueryCommand({
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        KeyConditionExpression: keyConditionExpression,
        FilterExpression: filterExpression,
        ScanIndexForward: scanIndexForward,
        TableName: this.tableName,
        IndexName: indexName,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    if (Items?.length) items.push(...(Items as Type[]))

    if (recursive && LastEvaluatedKey) {
      return this.query<Type>({
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
      data: items,
      lastEvaluatedKey: LastEvaluatedKey,
    }
  }

  async scan<Type>({
    exclusiveStartKey,
    items = [],
    query,
    recursive,
    filterDeleted = true,
  }: Scan<Type>): Promise<{
    data: Type[]
    lastEvaluatedKey?: Record<string, string>
  }> {
    const expressionAttributeNames = buildExpressionAttributeNames(query)
    const expressionAttributeValues = buildExpressionAttributeValues(query)
    let filterExpression = buildFilterExpression(query)

    if (expressionAttributeNames && filterDeleted) {
      expressionAttributeNames['#deletedAt'] = 'deletedAt'
      filterExpression = filterExpression
        ? `${filterExpression} AND attribute_not_exists(#deletedAt)`
        : 'attribute_not_exists(#deletedAt)'
    }

    const { Items, LastEvaluatedKey } = await this.dynamoDB.send(
      new ScanCommand({
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        FilterExpression: filterExpression,
        TableName: this.tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    if (Items?.length) items.push(...(Items as Type[]))

    if (recursive && LastEvaluatedKey) {
      return this.scan<Type>({
        exclusiveStartKey: LastEvaluatedKey,
        items,
        query,
        recursive,
      })
    }

    return { data: items, lastEvaluatedKey: LastEvaluatedKey }
  }

  async update<Type>({ key, item }: Update) {
    item.updatedAt = +new Date()
    await this.dynamoDB.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: buildUpdateExpression(item),
        ExpressionAttributeNames: buildExpressionAttributeNames(item),
        ExpressionAttributeValues: buildExpressionAttributeValues(item),
      }),
    )
    return this.get<Type>({ key })
  }
}
