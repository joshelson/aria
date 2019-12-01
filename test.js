import parser from "xmldoc";

const makeAction = (xml, parent) => {

    const action = {};
  
    action.name = xml.name;
  
    console.log(`Creating Action '${action.name}' With Text Value '${xml.val}' | Child length: ${xml.children.length}.`);
  
    action.value = xml.val.trim();
    action.parameters = xml.attr;
    action.call = parent;
    action.next = null;
    action.children = null;
  
    let lastChild = null;
    if (xml.children && xml.children.length > 1) {
      for (let i = 0; i < xml.children.length; i = i + 1) {
        const x = xml.children[i];
        console.log(`Calling makeAction on Child: ${util.inspect(x)}`);
        const a = makeAction(x, parent);
        if (!action.children) {
          action.children = a;
          lastChild = a;
        } else {
          lastChild.next = a;
          lastChild = a;
        }
      }
      lastChild.next = null;
    }
  
    return action;
  };

/* Sample TWIML:

<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect you to our switchboard.</Say>
  <Dial>
    <Number>+18004444444</Number>
  </Dial>
</Response>

*/

var xml = new parser.XmlDocument('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Please wait while we connect you to our switchboard.</Say><Dial><Number>+18004444444</Number></Dial></Response>');

console.log(`Document input: ${xml}\n------\n`);

xml.eachChild((command, index, {length}) => {

    console.log(`Child Node: ${command}`);
    makeAction(command);

});
