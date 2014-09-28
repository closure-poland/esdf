var when = require('when');
var pipeline = require('when/pipeline');
var Errors = require('../Errors');

function isAggregateInstance(testedObject){
	//TODO: Create a better heuristic for this. For now, since we may not assume an AR uses ES, we can not use any of the methods defined in EventSourcedAggregate, besides getAggregateID.
	return typeof(testedObject.getAggregateID) === 'function';
}

//TODO: Turn LoaderStageProvider into an interface!
/**
 * @typedef LoaderStageProvider
 * @property {function(IAggregateRoot): Promise.<IAggregateRoot>} rehydrateObject
 */

/**
 * An AggregateLoader is a component used for loading Aggregate Roots from persistent storage. It provides a rehydration service. However, it is not responsible for saving the aggregates.
 * @constructor
 * @param {LoaderStageProvider[]} stageProviders Providers of loading functions to be used in the sequence as passed.
 */
function AggregateLoader(stageProviders){
	this._stageProviders = stageProviders;
	//TODO: Introduce switchable providers, based on the type of aggregate that is passed in. This would allow hybrid applications using a single loader to exist.
	// Alternatively, a rule must be set that separate aggregate loaders be used for different parts of the system (for example, Loader A for the event-sourced part and B for traditional DDD).
}

//TODO: Document the constructor's type more precisely, supplying something particular instead of {function}. Could be realized by defining the aggregate constructor type with a @typedef in ../Core/ .
/**
 * Load an aggregate by creating it from the provided constructor and rehydrating by using the rehydration stage providers accessible within this loader.
 * @method
 * @public
 * @param {function} aggregateConstructor The constructor that should be called first to instantiate the aggregate.
 * @returns {Promise.<IAggregateRoot>}
 */
AggregateLoader.prototype.loadAggregate = function loadAggregate(aggregateConstructor, aggregateID){
	// Create the instance and set its aggregate ID. Notice how chaining is used, so that we support immutable objects out-of-the-box.
	var aggregateInstance = (new aggregateConstructor()).setAggregateID(aggregateID);
	var rehydrators = this._stageProviders.map(function getRehydrationFunction(stageProvider){
		return stageProvider.rehydrateObject.bind(stageProvider);
	});
	var loadingPromise = pipeline(rehydrators, aggregateInstance);
	return loadingPromise.then(function postProcessLoadedAggregate(processedInstance){
		// Sanity check: verify that the last function in the pipeline has indeed returned our aggregate.
		if(!isAggregateInstance(processedInstance)){
			throw new Errors.LoaderOutputMalformedError(processedInstance);
		}
		// Provide the aggregate instance to the caller. This concludes the loading process.
		return aggregateInstance;
	});
};

module.exports.AggregateLoader = AggregateLoader;