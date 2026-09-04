export const BULK_OPERATION_RUN_QUERY = `#graphql
  mutation RunBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: true) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const BULK_OPERATION_STATUS_QUERY = `#graphql
  query BulkOperationStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      url
      partialDataUrl
    }
  }
`;
