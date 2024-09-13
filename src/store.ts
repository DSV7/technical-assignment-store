import { JSONArray, JSONObject, JSONPrimitive } from "./json-types";
import "reflect-metadata"

export type Permission = "r" | "w" | "rw" | "none";
export type StoreResult = Store | JSONPrimitive | undefined;
export type StoreValue = JSONObject | JSONArray | StoreResult | (() => StoreResult);


export interface IStore {
  defaultPolicy: Permission;
  allowedToRead(key: string): boolean;
  allowedToWrite(key: string): boolean;
  read(path: string): StoreResult;
  write(path: string, value: StoreValue): StoreValue;
  writeEntries(entries: JSONObject): void;
  entries(): JSONObject;
}

// utilisation de symbol pour s'assurer de créer des permissions uniques
const PERMISSIONS_KEY = Symbol('permissions');



// Nous nous sommes servis de la librairie reflect-metadata pour ajouter les permissions dans des métadonnées sans modifier le comportement du code,
// mais nous permettant de les consulter au moment voulu pour contrôler les accès

// Permission set à "none" pour le Restrict vide dans adminStore qui doit se comporter comme tel
export function Restrict(permission: Permission = "none") {
  return function (target: any, propertyKey: any ) {
    const Permissions = Reflect.getMetadata(PERMISSIONS_KEY, target) || {};
    Permissions[propertyKey] = permission;
    Reflect.defineMetadata(PERMISSIONS_KEY, Permissions, target);
  };
}


export class Store implements IStore {
  defaultPolicy: Permission = "rw";


// fonction retournant la permission d'un prototype pour une key donnée en entrée
  private getPermissions(key: string): Permission {
    // On récupère l'information du prototype et non de l'instance
    const prototype = Object.getPrototypeOf(this);
    const permissionMap = Reflect.getMetadata(PERMISSIONS_KEY, prototype);
    const permission = permissionMap ? permissionMap[key] : undefined;
    // On retourne la permission trouvée ou la defaultPolicy sinon
    return permission || this.defaultPolicy;
  }

// fonction retournant un booléen avec une key en entrée. True si la permission de cette key contient READ, false sinon
  allowedToRead(key: string): boolean {
    const permission = this.getPermissions(key);
    return permission === "r" || permission === "rw";
  }

// fonction retournant un booléen avec une key en entrée. True si la permission de cette key contient WRITE, false sinon
  allowedToWrite(key: string): boolean {
    const permission = this.getPermissions(key);
    return permission === "w" || permission === "rw";
  }

// fonction nous permettant de READ, selon un path donnée (peut contenir des valeurs imbriquées)
  read(path: string): StoreResult {
    // séparateur pour les valeurs imbriquées
    const keys = path.split(':');
    // data contenu dans la requête
    let data: any = this;
  
    // dans le cas de valeurs imbriquées, nous allons de key en key
    for (const key of keys) {
      // nous commençons dans le cas ou data est une instance Store
      if (data instanceof Store) {
        // (data as any) pour éviter les erreurs liées au type Store
        if (typeof (data as any)[key] === "function") {
          data = (data as any)[key]();
          if (data instanceof Store) {
            // Si la fonction de résultat est de type Store, on continue. On retourne la valeur sinon
            continue;
          } else {
            return data;
          }
        }
        // si la key est dans data et que la permission de READ est vérifiée
         else if (key in data && data.allowedToRead(key)) {
          data = data[key as keyof Store];
        } else {
          throw new Error(`Property ${key} does not exist or cannot be read`);
        }
      }
      // Si key n'est pas une instance de Store, on vérifie si elle existe dans data
       else if (key in data) {
        data = data[key];
      } else {
        throw new Error(`Property ${key} does not exist`);
      }
    }
  
    return data;
  }
  

  // fonction nous permettant de WRITE une value (en sortie), selon un path donné (peut contenir des valeurs imbriquées)
  write(path: string, value: StoreValue): StoreValue {
    // on navigue dans les valeurs imbriquées de la même manière que la fonction READ
    const keys = path.split(':');
    let data: any = this;
  
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
  
      // La dernière key d'un path est celle dans laquelle on peut WRITE. S'il n'y a qu'une valeur, alors on essaie de WRITE dans la key donnée
      if (i === keys.length - 1) {
        if (data.allowedToWrite(key)) {
          if (typeof value === "object" && value !== null && !(value instanceof Store)) {
            // dans le cas ou la value donnée a WRITE n'est pas une instance de Store, nous la convertissons en tant que telle
            // Cela nous permet d'utiliser la fonction READ par la suite si nous voulons
            data[key] = this.convertToStore(value as JSONObject);
          } else {
            // Sinon, nous pouvons simplement retourner la value
            data[key] = typeof value === "function" ? value() : value;
          }
        } else {
          throw new Error(`Write access denied for key: ${key}`);
        }
      } else {
        // Pour les keys intermédiaires (dans le cas de valeurs imbriquées)
        if (!data[key]) {
          // Si la key n'existe pas dans data, nous devons nous assurer qu'il nous est possible de la WRITE (de la créer)
          if (!data.allowedToWrite(key)) {
            throw new Error(`Write access denied for intermediate key: ${key}`);
          }
          // Si nous avons la permission de WRITE, alors nous créons cette key dans data sous un type Store pour la suite
          data[key] = new Store();
        }
      // Nous pouvons passer à la key suivante du noeud, jusqu'à arriver à la dernière
        data = data[key];
      }
    }
  
    return value;
  }
  
  //fonction récursive utilisée dans la fonction WRITE nous permettant de convertir en type Store
  private convertToStore(obj: JSONObject): Store {
    const store = new Store();
    for (const [key, value] of Object.entries(obj)) {
      // si la valeur de value est un autre objet, on le convertit à nouveau, d'où la récursivité de la fonction
      if (typeof value === "object" && value !== null) {
        store.write(key, this.convertToStore(value as JSONObject));
      } 
      // sinon on peut ajouter value dans store
      else {
        store.write(key, value as JSONPrimitive);
      }
    }
    return store;
  }

  // fonction nous permettant de WRITE plusieurs valeurs à la fois, également des valeurs imbriquées
  writeEntries(entries: JSONObject): void {
    // Nous traitons les valeurs imbriquées grâce à la récursivité
    const writeEntry = (currentPath: string, value: any) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // nestedKey est la key de l'objet imbriqué, nestedValue est sa valeur
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          //s'il y a un path existant, donc que nous ne sommes pas à la racine, nous ajoutons ":" ainsi que la nestedKey
          // si nous sommes à la racine, alors nous ajoutons seulement la nestedKey
          const newPath = currentPath ? `${currentPath}:${nestedKey}` : nestedKey;
          // on traite de nouveau les valeurs imbriquées avec le nouveau path
          writeEntry(newPath, nestedValue);
        }
      } else {
        // Un fois que tout est traité et que nous avons le path complet jusqu'à value sous la forme que write peut comprendre,
        // nous écrivons la valeur
        this.write(currentPath, value);
      }
    };

  // C'est ici, en parcourant les différentes key, que nous appelons la fonction (récursive pour les valeurs imbriquées) writeEntry.
    for (const [key, value] of Object.entries(entries)) {
      writeEntry(key, value);
    }
  }

  // cette fonction renvoie les keys de l'instance, possèdant la permission de READ
  entries(): JSONObject {
    const result: JSONObject = {};
    // nous parcourons toutes les keys du JSONObject en entrée
    // si cette key est autorisé à la lecture, alors nous l'ajoutons dans notre résultat que nous retournerons en sortie
    for (const key of Object.keys(this)) {
      if (this.allowedToRead(key)){
        result[key] = (this as any)[key];
      }
    }
  
    return result;
  }


}




