/**************************************************************************************

    Aria Call Object
    
    Contains the constructor for Aria call objects. Also includes a set of top-level
    convenience functions for fetching Twiml and generating a linked list of
    actions to process. 

    TODO: In reality Aria could handle any number of other script formats. Twiml is
    convenient because there are already libraries out there that generate it. At
    some point in the future it would be fun to wrap up the twiml-specific bits in
    a node module and make the interpreter generic, such that you could use other
    inputs - perhaps a JSON-based script - to drive the Aria engine.
    
**************************************************************************************/

const makeAction = ({name, val, attr, children}, parent) => {

  const action = {};

  action.name = name;
  action.value = val.trim();
  action.parameters = attr;
  action.call = parent;
  action.next = null;
  action.children = null;

  let lastChild = null;
  if (children && children.length > 0) {
    for (let i = 0; i < children.length; i = i + 1) {
      const x = children[i];
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

// make subsequent requests, optionally passing back data
const fetchTwiml = (method, twimlURL, call, data) => {

  console.log(`Fetching Twiml From: ${twimlURL}`);
  
  const options = {
    method: method || "POST",
    body: data || null
  };

  const elements = url.parse(twimlURL);
  if (!elements.protocol) {
    twimlURL = url.resolve(call.baseUrl, twimlURL);
  }
  
  fetch(twimlURL, options)
    .then(res => res.text()).then(twiml => {
      // create the linked list of actions to execute
      const first = null;
      let last = null;

      // wipe out the old stack
      call.stack = null;

console.log("XML Body:");
console.log(twiml);

      // parse the xml and create a new stack
      const xml = new parser.XmlDocument(twiml);
      xml.eachChild((command, index, {length}) => {

        const action = makeAction(command, call);
        if (!call.stack) {
          call.stack = action;
          last = action;
        } else {
          last.next = action;
          last = action;
        }
        if (index === (length - 1)) {
          last.next = null;
          call.processCall();
        }
      });
    });
};

// load up a form data object with standard call parameters
const setCallData = ({sid, from, to, status}, form) => {
  form.append("CallSid", sid);
  form.append("AccountSid", "aria-call"); // perhaps use local IP or hostname?
  form.append("From", from);
  form.append("To", to);
  form.append("CallStatus", status);
  form.append("ApiVersion", "0.0.1");
  form.append("Direction", "inbound"); // TODO: fix this to reflect actual call direction
  form.append("ForwardedFrom", ""); // TODO: fix this too
  form.append("CallerName", ""); // TODO: and this
};

class AriaCall {
  constructor(client, channel, url, twiml, done) {

    const that = this;

    this.client = client; // a reference to the ARI client
    this.baseUrl = url; // the base URL from whence the Twiml was fetched
    this.stack = null; // the call stack 

    this.originatingChannel = channel; // the channel that originated the call (incoming)
    this.dialedChannel = null; // the dialed channel (if any) for the call
    
    this.channel = this.originatingChannel; // the active channel object for the call
    
    this.playback = null; // the placeholder for an active playback object
    this.stopOnTone = false; // should the playback be stopped when a tone is received?

    this.digits = "";
    this.digitTimer = null; // timer used to wait for digits;
    this.maxDigits = 0; // maximum number of digits to collect
    this.termDigit = "#"; // digit used to signal end of collection
    this.digitCallback = null; // callback on digit collection

    this.hungup = false; // hangup flag
    this.hangupCallback = null; // callback on hangup

    this.from = channel.caller.number;
    this.to = "";
    this.createTime = new Date().getTime();
    this.status = "Awesome";
    
    this.sid = uuid.v4();
    
    // advance to the next action in the list
    this.advancePointer = () => {
      if (that.stack.next) {
        that.stack = that.stack.next;
        that.processCall();
      } else {
        that.terminateCall();
      }
    };

    channel.on("ChannelDtmfReceived", ({digit}, {id}) => {
      console.log(`Channel ${id} - Digit: ${digit}`);
      that.digits += digit;
      if (that.digitCallback) {
        that.digitCallback(digit, that.digits);
      }
    });

    channel.on("ChannelHangupRequest", (evt, {id}) => {
      console.log(`Channel ${id} - Hangup Request`);
      that.hungup = true;
      if (that.hangupCallback) {
        that.hangupCallback();
      }
    });

    // fetch the Twiml for this call
    fetchTwiml("GET", url, that, null);

  }

  processCall() {
    const command = this.stack;
    const action = twimlActions[command.name];
    if (!action) {
      console.log(`Invalid or improper command: ${command.name}`);
      this.terminateCall();
    } else {
      action(command, command.call.advancePointer);
    }
  }

  terminateCall() {
    // post the call record to the account's call history URI if set;
    // do other post-call stuff here
    const milliseconds = new Date().getTime();
    console.log(`Channel ${this.channel.id} - Call duration: ${milliseconds - this.createTime}ms`);
    if (!this.hungup) {
      try {
        this.channel.hangup();
      } catch (e) {
        // must have already hung up
      }
    }
  }
}



