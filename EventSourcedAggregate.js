/**
 * @module esdf/core/EventSourcedAggregate
 */

var EventEmitter = require('events').EventEmitter;
var when = require('when');
var uuid = require('uuid');

/**
 * Basic constructor for creating an in-memory object representation of an Aggregate. Aggregates are basic business objects in the domain and the primary source of events.
 * The created Aggregate instance supports EventEmitter's on() listener registration to define how events alter the state of the Aggregate (and thus, of the application).
 * An aggregate should typically listen to its own events (define event handlers) and react by issuing such state changes, since it is the only keeper of its own internal state.
 * You *are* supposed to use this as a prototype for your own Aggregate constructors.
 * 
 * @constructor
 */
function EventSourcedAggregate(){
	/**
	 * Aggregate ID, used when loading (rehydrating) the object from an Event Sink.
	 * @private
	 */
	this.aggregateID = null;
	/**
	 * Pending event sequence number, used for event ordering and optimistic concurrency collision detection.
	 * @private
	 */
	this.nextSequenceNumber = 1;
	/**
	 * Array of the events to be saved to the Event Sink within a single commit when commit() is called.
	 * @private
	 */
	this.stagedEvents = [];
	/**
	 * The assigned Event Sink that events will be committed to. This variable should be assigned from the outside using the assignEventSink method.
	 * @private
	 */
	this.eventSink = null;
	/**
	 * Previously executed command IDs. Used for idempotent command deduplication.
	 * @private
	 */
	this._executedCommands = {};
}
//use the event emitter prototype to define listener interactions and the emit function
EventSourcedAggregate.prototype = new EventEmitter();

/**
 * Assign an event sink to the Aggregate that it will be able to commit() its staged events to.
 * 
 * @param {EventSink} event_sink The Event Sink to assign.
 * @throws {Error} When the supplied object does not look like an Event Sink (does not have its sink() method).
 */
EventSourcedAggregate.prototype.assignEventSink = function assignEventSink(event_sink){
	if(typeof(event_sink) === 'object' && typeof(event_sink.sink) === 'function'){
		this.eventSink = event_sink;
	}
	else{
		throw new Error('The supplied object is not suitable for use as an Event Sink');
	}
};

/**
 * Helper function, used mainly by Event Sink implementations to apply batches of events without duplicating code.
 * 
 * @param {Array} event_array The array of events to apply. Each array element must be an object with at least EventType and EventObject properties, which will be used when applying.
 */
EventSourcedAggregate.prototype.applyCommit = function applyCommit(event_array){
	for(var i = 0; i < event_array.length; i++){
		this.apply(event_array[i].EventType, event_array[i].EventObject);
		//If the event carries a CommandID tag...
		if(typeof(event_array[i].CommandID) === 'string'){
			//Flag the command as already executed.
			this._executedCommands[event_array[i].CommandID] = true;
		}
	}
	this.nextSequenceNumber++;
};


/**
 * Apply the event to the Aggregate by calling the appropriate registered event handlers. Also increment the current sequence number.
 * 
 * @param {string} event_name The name of the event to be applied. This is the same name as is used with .on() invocations when registering handlers/listeners.
 * @param {Object} event_object The payload in form of a JavaScript object. It will be passed to the event handler function as the first argument verbatim.
 */
EventSourcedAggregate.prototype.apply = function apply(event_name, event_object){
	if(!event_name || !event_object){
		throw new Error('EventSourcedAggregate.apply requires at least an event name and an event object as its arguments.');
	}
	this.emit.apply(this, arguments); //EventEmitter's actual in-process event publish - pass-through the same arguments that we got to it.
};

/**
 * Stage an event for committing later. Immediately applies the event to the Aggregate (via the built-in EventEmitter), so rolling back is not possible (reloading the Aggregate from the Event Sink and retrying can be used instead, see utils.tryWith).
 * 
 * @param {string} event_type Type of the event to apply. This is the name used both for routing the event to local listeners (including the Aggregate's own) and saving it to the Event Sink.
 * @param {Object} event_params The event payload to pass to local listeners and the Event Sink.
 */
EventSourcedAggregate.prototype.stage = function stage(event_type, event_params, command_id){
	//Make sure that only string command IDs are saved.
	if(typeof(command_id) === 'number'){
		command_id = command_id + '';
	}
	if(typeof(command_id) === 'string'){
		//If we have a command ID, register the command as already executed.
		this._executedCommands[command_id] = true;
	}
	this.stagedEvents.push({
		EventID: uuid.v4(),
		EventType: event_type,
		EventObject: event_params,
		CommandID: command_id
	});
	this.apply(event_type, event_params);
	return true;
};

/**
 * Save all staged events to the Event Sink (assigned earlier manually from outside to the Aggregate's "eventSink" property).
 * Emits an "error" event should any saving errors occur (allowing higher layers to reload the Aggregate and retry whatever they were doing with it).
 * In case no events were actually staged, this function will not attempt to sink an empty commit, resolving the sink promise immediately.
 * 
 * @returns {Promise} Promise/A-compliant promise object which supports then(). The promise is resolved when the event is saved, and rejected if the saving fails for any reason (including optimistic concurrency).
 */
EventSourcedAggregate.prototype.commit = function commit(){
	var self = this;
	var emit_deferred = when.defer(); //emission promise - to be resolved when the event batch is saved in the database
	//Guard clause - if no events staged, do not litter the Event Store (especially useful with the idempotency wrapper deduplicateMethodCall).
	if(self.stagedEvents.length < 1){
		return emit_deferred.resolver.resolve(true);
	}
	when(self.eventSink.sink(self.stagedEvents, self.aggregateID, self.nextSequenceNumber),
	function _eventSinkSucceededucceeded(result){
		self.nextSequenceNumber++;
		return emit_deferred.resolver.resolve(true);
	},
	function _eventSinkFailed(reason){
		setImmediate(function(){
			self.apply('error', reason);
		});
		return emit_deferred.resolver.reject(reason);
	}); //this is a promise (thenable), so return its consumer-meant part
	return emit_deferred.promise;
};

/**
 * Wrap a method in a deduplication layer. The layer ensures that duplicate method calls (recognized via a supplied command ID, always the first argument) will always return the same value.
 * 
 * @returns {methodCallDeduplicationWrapper} The call deduplication wrapper function.
 */
EventSourcedAggregate.deduplicateCommand = function deduplicateCommand(method){
	return function methodCallDeduplicationWrapper(command_id){
		//Turn the arguments into a proper array.
		if(!this._executedCommands[command_id]){
			//We have not seen this command ID in the past, so issue the command as usual. In case it does turn out to be a duplicate anyway (because our state was not yet updated), we have optimistic concurrency to help us.
			method.apply(this, arguments);
			//Commands may never return any values, so explicitly return undefined.
			return;
		}
		else{
			return;
		}
	};
};
/**
 * Takes a command ID, and possibly other arguments, and executes the wrapped method.
 * 
 * @name methodCallDeduplicationWrapper
 * @function
 * @param {string} command_id
 */

module.exports.EventSourcedAggregate = EventSourcedAggregate;