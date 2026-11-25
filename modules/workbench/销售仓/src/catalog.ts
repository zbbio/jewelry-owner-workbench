export type ProductFacts={productId:string;cardId:string;version:number;priceText:string|null;size:string|null};
export type CatalogPort={read(productId:string):ProductFacts};
export type Turn={productId:string|null;text:string};
export type Evidence={productId:string;label:string;value:string};
