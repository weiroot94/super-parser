// Import the querystring module
import { stringify } from "querystring";
  
// Specify the URL object
// to be serialized
const user = 'john';
let urlObject = {
    user,
    access: false,
    role: ["editor", "manager"],
};
  
// Use the stringify() method on the object
// with sep as `, ` and eq as `:`
let parsedQuery = stringify(urlObject);
  
console.log("Parsed Query 1:", parsedQuery);
  
