/**
 * @module esdf/core/EventSourcedAggregate
 */

var EventEmitter = require('eventemitter2').EventEmitter2;
var AggregateSnapshot = require('./utils/AggregateSnapshot.js').AggregateSnapshot;
var when = require('when');
var uuid = require('uuid');

var Commit = require('./Commit.js').Commit;

/**
 * Basic constructor for creating an in-memory object representation of an Aggregate. Aggregates are basic business objects in the domain and the primary source of events.
 * The created Aggregate instance supports EventEmitter's on() listener registration to define how events alter the state of the Aggregate (and thus, of the application).
 * An aggregate should typically listen to its own events (define event handlers) and react by issuing such state changes, since it is the only keeper of its own internal state.
 * You *are* supposed to use this as a prototype for your own Aggregate constructors.
 * 
 * @constructor
 */
function EventSourcedAggregate(){
	this._initializeAggregateMetadata();
}
//use the event emitter prototype to define listener interactions and the emit function

//TODO: document this abomination
EventSourcedAggregate.prototype._initializeAggregateMetadata = function _initializeAggregateMetadata(){
	/**
	 * Aggregate ID, used when loading (rehydrating) the object from an Event Sink.
	 * @private
	 */
	this._aggregateID = undefined;
	/**
	 * Pending event sequence number, used for event ordering and optimistic concurrency collision detection.
	 * @private
	 */
	this._nextSequenceNumber = 1;
	/**
	 * Array of the events to be saved to the Event Sink within a single commit when commit() is called.
	 * @private
	 */
	this._stagedEvents = [];
	/**
	 * The assigned Event Sink that events will be committed to. This variable should be assigned from the outside using the assignEventSink method.
	 * @public
	 */
	this._eventSink = undefined;
	
};

/**
 * Apply the given commit to the aggregate, causing it to apply each event, individually, one after another.
 * 
 * @param {module:esdf/core/Commit.Commit} commit The commit object to apply.
 */
EventSourcedAggregate.prototype.applyCommit = function applyCommit(commit){
	var self = this;
	commit.events.forEach(function(event){
		// The handler only gets the event and the commit metadata. It is not granted access to other events in the commit.
		self._applyEvent(event, commit.metadata);
	});
	// Increment our internal sequence number counter.
	this._nextSequenceNumber++;
};


/**
 * Apply the event to the Aggregate by calling the appropriate registered event handlers.
 * 
 * @param {module:esdf/core/Event.Event} event The event to apply.
 * @param {Object} commitMetadata Metadata associated with the commit containing the event - for example, context information about the command used when generating it.
 * 
 */
//TODO: document the handler function contract using JSDoc or any other means available.
EventSourcedAggregate.prototype._applyEvent = function _applyEvent(event, commitMetadata){
	var handlerFunctionName = 'on' + event.eventType;
	if(typeof(this[handlerFunctionName]) === 'function'){
		this[handlerFunctionName](event, commitMetadata);
	}
	else{
		throw new Error('Event type ' + event.eventType + ' applied, but no handler was available - bailing out to avoid programmer error!');
	}
};

/**
 * Stage an event for committing later. Immediately applies the event to the Aggregate (via the built-in EventEmitter), so rolling back is not possible (reloading the Aggregate from the Event Sink and retrying can be used instead, see utils.tryWith).
 * 
 * @param {module:esdf/core/Event.Event} event The event to be enqueued for committing later.
 */
EventSourcedAggregate.prototype._stageEvent = function _stageEvent(event){
	event.aggregateID = this._aggregateID;
	this._stagedEvents.push(event);
	this._applyEvent(event);
	return true;
};

//TODO: documentation (especially concerning the hack below)
EventSourcedAggregate.prototype._getSnapshotData = function _getSnapshotData(){
	throw new Error('Unimplemented!');
};
EventSourcedAggregate.prototype._getSnapshotData.unimplemented = true;


/**
 * Save all staged events to the Event Sink (assigned earlier manually from outside to the Aggregate's "_eventSink" property).
 * Emits an "error" event should any saving errors occur (allowing higher layers to reload the Aggregate and retry whatever they were doing with it).
 * 
 * @returns {Promise} Promise/A-compliant promise object which supports then(). The promise is resolved when the commit is saved, and rejected if the saving fails for any reason (including optimistic concurrency).
 */
EventSourcedAggregate.prototype.commit = function commit(){
	var self = this;
	var emitDeferred = when.defer(); //emission promise - to be resolved when the event batch is saved in the database
	// NOTE: Sinking an empty commit *is a valid operation* from the AR's point of view! It is up to the _eventSink how it handles this.
	//  The sink could discard the empty commit if it has another way of establishing read precedence (e.g. a vector clock). See document "Full-stack idempotency" for an overview.
	// Try to sink the commit.
	var commitObject = new Commit(this._stagedEvents, this._aggregateID, this._nextSequenceNumber);
	when(self._eventSink.sink(commitObject),
	function _commitSinkSucceeded(result){
		self._stagedEvents = [];
		self._nextSequenceNumber = self._nextSequenceNumber + 1;
		return emitDeferred.resolver.resolve(result);
	},
	function _commitSinkFailed(reason){
		return emitDeferred.resolver.reject(reason);
	}); //This is a promise (thenable), so return its consumer-facing part.
	return emitDeferred.promise;
};

EventSourcedAggregate.prototype.saveSnapshot = function saveSnapshot(){
	var self = this;
	if(typeof(this._getSnapshotData) === 'function' && !this._getSnapshotData.unimplemented){
		return this._snapshotter.saveSnapshot(new AggregateSnapshot(this._aggregateID, this._getSnapshotData(), (this._nextSequenceNumber - 1)));
	}
	else{
		return when.reject('Not saving snapshot - aggregate does not implement _getSnapshotData()');
	}
};

module.exports.EventSourcedAggregate = EventSourcedAggregate;