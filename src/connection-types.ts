export interface ConnectionDescriptor {
  connectionId: string;
  endpoint: string;
  token: string;
  pid: number;
  workspaceName?: string;
  workspaceFolders: string[];
  updatedAt: number;
}

export interface PublicConnectionDescriptor
  extends Omit<ConnectionDescriptor, "token"> {
  selected: boolean;
}
