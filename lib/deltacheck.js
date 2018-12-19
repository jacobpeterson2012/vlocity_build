var fs = require('fs-extra');
var path = require('path');

var DeltaCheck = module.exports = function(vlocity) {
    this.vlocity = vlocity || {};
};

DeltaCheck.prototype.runDeltaCheck = async function(jobInfo, currentContextData) {
    this.jobInfo = jobInfo;
    this.jobInfo.deltaCheckResults = {};

    currentContextData = this.vlocity.utilityservice.checkNamespacePrefix(currentContextData);
    this.sObjectInfo = {};
    this.querySObjectsInfo = {};
    this.queryFieldsInfo = {};
    this.deltaCheckJobInfo = {
        deltaQueryChildrenDefinition : {},
        queryForChildren : {},
        contextDataToCompareAgainst : {},
        generatedMatchingKeyValueToId : {},
        replaceMatchingKeyValueWithId : {},
        matchingKeyFieldToDataPack: {},
        whereClauseHashToVlocityDataPackKey: {},
        unhashableFields: {},
        childToParentLookupField: {},
        matchingKeyFieldValueToWhereClauseHash: {},
        vlocityRecordSourceKeyToDataPackKey: {},
        whereClauseHashToVlocityRecordSourceKey: {},
        matchingKeyValueByType : {}
    };

    var matchingKeys = await this.vlocity.utilityservice.getAllDRMatchingKeys();
    this.vlocityMatchingKeys = this.vlocity.utilityservice.checkNamespacePrefix(matchingKeys);
    
    await this.getAllRecordsToQueryFor(currentContextData);
    
    var queryResult = await this.executeQueries(this.querySObjectsInfo);

    if (queryResult && !this.vlocity.utilityservice.isEmptyObject(queryResult)) {
        for (var sObjectType in queryResult) {
            for (var whereClauseKey in queryResult[sObjectType]) {

                var sourcekey = this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType][whereClauseKey];
                await this.addChildrenQueryIfExist(sObjectType, queryResult[sObjectType][whereClauseKey], sourcekey);
            }
        }
       
        if (!this.vlocity.utilityservice.isEmptyObject(this.deltaCheckJobInfo.generatedMatchingKeyValueToId)) {
            await this.buildQueryMap(this.deltaCheckJobInfo.generatedMatchingKeyValueToId, true, true);
        }

        this.querySObjectsInfo = {};
        
        if (!this.vlocity.utilityservice.isEmptyObject(this.deltaCheckJobInfo.queryForChildren)) {
            await this.buildQueryMap(this.deltaCheckJobInfo.queryForChildren, true, false);
        }

        this.isChildrenQueries = true;

    
        var secondQueryResult = await this.executeQueries(this.querySObjectsInfo);

        if (secondQueryResult) {
            for (sObjectType in secondQueryResult) {
                if (!queryResult.hasOwnProperty(sObjectType)) {
                    queryResult[sObjectType] = {};
                }
    
                for (whereClauseKey in secondQueryResult[sObjectType]) {
                    queryResult[sObjectType][whereClauseKey] = secondQueryResult[sObjectType][whereClauseKey];
                }
            }
        }
    }

    await this.compareQueryResultWithDataPacks(this.jobInfo, queryResult, this.deltaCheckJobInfo.contextDataToCompareAgainst);
};

DeltaCheck.prototype.compareQueryResultWithDataPacks = async function(jobInfo, queryResult, dataPacks) {
    for (var sObjectType in queryResult) {
        for (var whereClauseHashKey in queryResult[sObjectType]) {
            if (!(dataPacks[sObjectType][whereClauseHashKey])) {
                var vlocityDataPackKey = this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType][whereClauseHashKey];
                jobInfo.deltaCheckResults[vlocityDataPackKey] = { status: 'Changed' };
            }
        }
    }

    for (var sObjectType in dataPacks) {
        for (var whereClauseHashKey in dataPacks[sObjectType]) {
            if (!queryResult[sObjectType] || !(queryResult[sObjectType][whereClauseHashKey])) {
                var vlocityDataPackKey = this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType][whereClauseHashKey];
                jobInfo.deltaCheckResults[vlocityDataPackKey] = { status: 'Changed' };
            } else {
                var dataPackData = dataPacks[sObjectType][whereClauseHashKey];
                var secondSObject = queryResult[sObjectType][whereClauseHashKey];

                if (!dataPackData.VlocityRecordSObjectType) {
                    dataPackData.VlocityRecordSObjectType = sObjectType;
                }
                
                await this.compareDataPackWithSObject(jobInfo, dataPackData, secondSObject, whereClauseHashKey);
            }
        }
    }
};

DeltaCheck.prototype.compareDataPackWithSObject = async function(jobInfo, dataPackData, sObject, whereClauseHashKey) {
        var recordSObjectType = dataPackData.VlocityRecordSObjectType;
        var vlocityDataPackKey = this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[recordSObjectType][whereClauseHashKey];

        if (!(jobInfo.deltaCheckResults[vlocityDataPackKey]
            && jobInfo.deltaCheckResults[vlocityDataPackKey].status 
            && jobInfo.deltaCheckResults[vlocityDataPackKey].status === 'Changed')) {
                
            recordSObjectType = this.vlocity.utilityservice.replaceNamespaceWithDefault(recordSObjectType);
            var unhashableFields = this.deltaCheckJobInfo.unhashableFields[recordSObjectType];

            if (!unhashableFields) {
                unhashableFields = this.vlocity.datapacksutils.getUnhashableFields(null, recordSObjectType);

                if (unhashableFields) {
                    unhashableFields = JSON.parse(this.vlocity.utilityservice.checkNamespacePrefix(JSON.stringify(unhashableFields)));
                    this.deltaCheckJobInfo.unhashableFields[recordSObjectType] = unhashableFields;
                }
            }

            this.removeUnhashableFields(unhashableFields, dataPackData);
            this.removeUnhashableFields(unhashableFields, sObject);

            for (var fieldName in dataPackData) {
                var dataPackValue = dataPackData[fieldName];
                var sObjectValue = sObject[fieldName];

                if (dataPackValue instanceof Array) {
                    continue;
                }
                
                if (dataPackValue instanceof Object) {
                    if (!dataPackValue.VlocityRecordSObjectType) {
                        continue;
                    }

                    var recordSObjectType = dataPackValue.VlocityRecordSObjectType;
                    var matchingKeyFieldValue = dataPackValue.VlocityLookupRecordSourceKey ?  dataPackValue.VlocityLookupRecordSourceKey : dataPackValue.VlocityMatchingRecordSourceKey;

                    if (this.deltaCheckJobInfo.matchingKeyValueByType[recordSObjectType]) {
                        dataPackValue = this.deltaCheckJobInfo.matchingKeyValueByType[recordSObjectType][matchingKeyFieldValue];

                        if (dataPackValue != null) {
                            dataPackValue = dataPackValue.substring(0, 15);

                            if (sObjectValue) {
                                sObjectValue = sObjectValue.substring(0, 15);
                            }

                        }
                    } else {
                        dataPackValue = null;
                    }
                }

                dataPackValue = this.formatIfDate(dataPackValue);
                sObjectValue = this.formatIfDate(sObjectValue);

                if (sObject.hasOwnProperty(fieldName)) {
                    if (sObjectValue == null) {
                        sObjectValue = "";
                    }

                    if (dataPackValue !== sObjectValue) {
                        if (!jobInfo.deltaCheckResults[vlocityDataPackKey]
                            || (jobInfo.deltaCheckResults[vlocityDataPackKey] && !jobInfo.deltaCheckResults[vlocityDataPackKey].records)) {
                            jobInfo.deltaCheckResults[vlocityDataPackKey] = { status: 'Changed', records: []}
                        }

                        jobInfo.deltaCheckResults[vlocityDataPackKey].records.push({ 
                            fieldName : [fieldName],
                            sObjectValue: sObjectValue,
                            dataPackValue: '',
                            recordType: dataPackData.VlocityRecordSObjectType
                        });
                    }
                }
            }

            if (!jobInfo.deltaCheckResults[vlocityDataPackKey]) {
                jobInfo.deltaCheckResults[vlocityDataPackKey] = { status: 'Unchanged' };
                jobInfo.currentStatus[vlocityDataPackKey] = 'Success';
            }
        }
};

DeltaCheck.prototype.removeUnhashableFields = function(unhashableFields, dataPackData) {
    if (unhashableFields) {
        unhashableFields.forEach(function(field) {
            delete dataPackData[field];
        });
    }
};

DeltaCheck.prototype.formatIfDate = function(date) {
    if (date
        && typeof(date) === 'string'
        && new Date(date) !== 'Invalid Date' 
        && !isNaN(new Date(date))) {
        date = date.substring(0, date.indexOf('.'));
    }

    return date;
};

DeltaCheck.prototype.buildQueryMap = async function(sObjects, replaceMatchingKeys, compare) {
    if (sObjects && !this.vlocity.utilityservice.isEmptyObject(sObjects)) {
        if (replaceMatchingKeys) {
            sObjects = this.replaceMatchingKeyValueWithId(sObjects);
        }

        var sObjectsWithMatchingFieldValues = this.replaceIdWithMatchingKeyValue(sObjects);
        
        for (sObjectType in sObjects) {
            for (var i = 0; i < sObjects[sObjectType].length; i++) {
                var sObject = sObjects[sObjectType][i];
                var fieldsDefinitionsMap = this.sObjectInfo[sObjectType].fieldsDefinitionsMap;
                var sObjectDescribe = this.sObjectInfo[sObjectType].sObjectDescribe;

                if (typeof sObject === 'undefined') {
                    continue;
                }

                var vlocityDataPackKey = sObject.vlocityDataPackKey;
                delete sObjects[sObjectType][i].vlocityDataPackKey;

                if (!sObjectDescribe) {
                    sObjectDescribe = await this.vlocity.utilityservice.describeSObject(sObjectType);
                    this.sObjectInfo[sObjectType].sObjectDescribe = sObjectDescribe;
                }

                if (!fieldsDefinitionsMap) {
                    fieldsDefinitionsMap = this.vlocity.utilityservice.getFieldsDefinitionsMap(sObjectDescribe);
                    this.sObjectInfo[sObjectType].fieldsDefinitionsMap = fieldsDefinitionsMap;
                }

                var matchingKeyFields = [];

                for (var field in sObject) {
                    matchingKeyFields.push(field);
                }
                
                var whereClauseMatchingFieldValue = this.buildWhereClauseHash(matchingKeyFields, sObjectsWithMatchingFieldValues[sObjectType][i], fieldsDefinitionsMap, sObjectType);
                var dataPack = sObject;

                if (this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType]
                    && this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType][whereClauseMatchingFieldValue]) {
                    dataPack = this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType][whereClauseMatchingFieldValue];
                }
                
                var whereClause = this.buildWhereClauseHash(matchingKeyFields, sObject, fieldsDefinitionsMap, sObjectType);

                if (!this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType]) {
                    this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType] = {};
                }

                this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType][whereClause] = vlocityDataPackKey;

                if (compare) {
                    if (!this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType]) {
                        this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType] = {};
                    }
                    
                    this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType][whereClause] = dataPack; 
                }

                if (!this.querySObjectsInfo[sObjectType]) {
                    this.querySObjectsInfo[sObjectType] = {};
                }

                this.querySObjectsInfo[sObjectType][whereClause] = dataPack;
            }
        }
    }

    return this.querySObjectsInfo;
};

DeltaCheck.prototype.replaceIdWithMatchingKeyValue = function(sObjects) {
    return this.replaceMatchingKeyValueWithId(sObjects);
};

DeltaCheck.prototype.replaceMatchingKeyValueWithId = function(sObjects) {
    var replacedKeyMap = {};

    for (var sObjectType in sObjects) {
        for (var i = 0; i < sObjects[sObjectType].length; i++) {
            if (!replacedKeyMap[sObjectType]) {
                replacedKeyMap[sObjectType] = [];
            }

            var sObjectMap = {};
            var parentNotFound = false;

            for (var fieldSObjectType in sObjects[sObjectType][i]) {
                if (!parentNotFound) {
                    if (sObjects[sObjectType][i][fieldSObjectType] instanceof Object) {
                        for (var fieldName in sObjects[sObjectType][i][fieldSObjectType]) {
                            if (this.deltaCheckJobInfo.matchingKeyValueByType[fieldSObjectType]
                                && this.deltaCheckJobInfo.matchingKeyValueByType[fieldSObjectType].hasOwnProperty(sObjects[sObjectType][i][fieldSObjectType][fieldName])) {
                                sObjectMap[fieldName] = this.deltaCheckJobInfo.matchingKeyValueByType[fieldSObjectType][sObjects[sObjectType][i][fieldSObjectType][fieldName]];
                            } else {
                                if (!this.jobInfo.deltaCheckResults[sObjects[sObjectType][i].vlocityDataPackKey]) {
                                    this.jobInfo.deltaCheckResults[sObjects[sObjectType][i].vlocityDataPackKey] = { status: 'Changed' };
                                }

                                var parentNotFound = true;
                                break;
                            }       
                        }
                    } else if (fieldSObjectType === 'vlocityDataPackKey') {
                        sObjectMap[fieldSObjectType] = sObjects[sObjectType][i][fieldSObjectType];
                        continue;
                    } else {
                        sObjectMap[fieldSObjectType] = sObjects[sObjectType][i][fieldSObjectType];
                    }
                }
            }

            if (!parentNotFound && !this.vlocity.utilityservice.isEmptyObject(sObjectMap)) {
                replacedKeyMap[sObjectType][i] = sObjectMap;
            }
        }
    }

    return replacedKeyMap;
};

DeltaCheck.prototype.getAllRecordsToQueryFor = async function(currentContextData) {
    for (var i = 0; i < currentContextData.length; i++) {
        var dataPack = this.vlocity.utilityservice.getDataPackData(currentContextData[i]);
        var vlocityDataPackKey = currentContextData[i].VlocityDataPackKey;
        await this.findAllRecords(dataPack, vlocityDataPackKey);
    }

    return this.querySObjectsInfo;
};

DeltaCheck.prototype.buildQueries = async function(queriesMap) {
    var queries = [];

    for (var sObjectType in queriesMap) {
        var query = { sObjectType: sObjectType };

        query.querySelect = queriesMap[sObjectType].querySelect;

        if (!query.querySelect) {
            query.querySelect = this.buildQuerySelect(this.sObjectInfo[sObjectType].sObjectDescribe);
            queriesMap[sObjectType].querySelect = query.querySelect;
        }

        query.whereClause = '';
        query.queryBase = 'SELECT ' + query.querySelect + ' FROM '+ query.sObjectType;

        for (var whereClauseHash in queriesMap[sObjectType]) {
            if (whereClauseHash === 'querySelect') {
                continue;
            }

            var whereClauseTemp = whereClauseHash; 

            if (queriesMap[sObjectType][whereClauseHash].whereClause) {
                whereClauseTemp = queriesMap[sObjectType][whereClauseHash].whereClause;
            }

            if (query.whereClause) {
                query.whereClause += ' OR ';
            }

            query.whereClause += '(' + whereClauseTemp + ')';

            if (query.whereClause.length > 10000) {
                queries.push(JSON.parse(JSON.stringify(query)));
                query.whereClause = '';
            }
        }

        if (query.whereClause) {
            queries.push(query);
        }

        for (var query of queries) {
            query.fullQuery = query.queryBase + ' WHERE ' + query.whereClause;
        }
    }

    return queries;
};

DeltaCheck.prototype.buildQuerySelect = function(sObjectDescribe) {
    return Object.keys(this.vlocity.utilityservice.getFieldsDefinitionsMap(sObjectDescribe));
};

DeltaCheck.prototype.executeQueries = async function(queriesMap) {
    var queriesList = await this.buildQueries(queriesMap);
    var queriedRecordsMap = {};
    var queryPromises = [];

    for (var query of queriesList) {
        
        queryPromises.push({ context: this, argument: { sObjectType: query.sObjectType, query: query.fullQuery, queriedRecordsMap: queriedRecordsMap }, func: 'runQuery' });
    }

    await this.vlocity.utilityservice.parallelLimit(queryPromises);
    this.processQueryResult(queriedRecordsMap);
    return queriedRecordsMap;
};

DeltaCheck.prototype.runQuery = async function(inputMap) {
    var sObjectType = inputMap.sObjectType;
    var query = inputMap.query;
    var queriedRecordsMap = inputMap.queriedRecordsMap;
    var result = await this.vlocity.queryservice.query(query);
    
    if (result && result.records.length > 0) {
        if (!queriedRecordsMap[sObjectType]) {
            queriedRecordsMap[sObjectType] = {};
        }
            
        for (var i = 0; i < result.records.length; i++) {
            var whereClauseHash = await this.buildUniqueKey(sObjectType, null, result.records[i], null);
            queriedRecordsMap[sObjectType][whereClauseHash] = result.records[i];
        }
    }
};

DeltaCheck.prototype.processQueryResult = function(queryResultMap) {
    if (queryResultMap) {
        for (var sObjectType in queryResultMap) {
            for (var whereClauseHash in queryResultMap[sObjectType]) {
                var sObject = queryResultMap[sObjectType][whereClauseHash];
                
                if (!this.deltaCheckJobInfo.matchingKeyValueByType[sObjectType]) {
                    this.deltaCheckJobInfo.matchingKeyValueByType[sObjectType] = {};
                }

                if (!this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType]) {
                    this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType] = {};
                }

                var recordSourceKey = this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType][whereClauseHash];

                this.deltaCheckJobInfo.matchingKeyValueByType[sObjectType][recordSourceKey] = sObject.Id.substring(0, 15);
                this.deltaCheckJobInfo.matchingKeyValueByType[sObjectType][sObject.Id.substring(0, 15)] = recordSourceKey;

                if (this.deltaCheckJobInfo.childToParentLookupField[sObjectType]) {

                    var parentField = this.deltaCheckJobInfo.childToParentLookupField[sObjectType].idField;
                    var parentValue = sObject[parentField];
                    var parentType = this.deltaCheckJobInfo.childToParentLookupField[sObjectType].sObjectType;
                    var parentSourceKey = this.deltaCheckJobInfo.matchingKeyValueByType[parentType][parentValue];
                    var parentDataPackKey = this.deltaCheckJobInfo.vlocityRecordSourceKeyToDataPackKey[parentSourceKey];

                    if (parentDataPackKey) {
                        this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType][whereClauseHash] = parentDataPackKey;
                    }
                }
            }
        }
    }
};

DeltaCheck.prototype.findAllRecords = async function(dataPack, vlocityDataPackKey) {
    await this.processDataPack(dataPack, vlocityDataPackKey, true, null);

    for (var dataPackField in dataPack) {
        if (dataPack[dataPackField]) {
            var matchingKeyFieldValue;
            var dataPackData;
            var isSObject = false;

            if (dataPack[dataPackField] instanceof Array) {
                for (var i = 0; i < dataPack[dataPackField].length; i++) {
                    await this.findAllRecords(dataPack[dataPackField][i], vlocityDataPackKey);
                }
            } else if (dataPack[dataPackField][0]
                && dataPack[dataPackField][0] instanceof Object
                && dataPack[dataPackField][0].VlocityRecordSObjectType) {
                isSObject = true;
                dataPackData = dataPack[dataPackField][0];
            } else if (dataPack[dataPackField].VlocityLookupRecordSourceKey
                && dataPack[dataPackField].VlocityRecordSObjectType !== 'RecordType') {
                dataPackData = dataPack[dataPackField];
                matchingKeyFieldValue = dataPackData.VlocityLookupRecordSourceKey;
            } else if (dataPack[dataPackField].VlocityMatchingRecordSourceKey) {
                dataPackData = dataPack[dataPackField];
                matchingKeyFieldValue = dataPackData.VlocityMatchingRecordSourceKey;
            } else {
                continue;
            }

            if (isSObject) {
                await this.findAllRecords(dataPackData, vlocityDataPackKey);
            } else if (matchingKeyFieldValue) {
               // await this.processDataPack(dataPackData, vlocityDataPackKey, false, matchingKeyFieldValue);
            }
        }
    }
};

DeltaCheck.prototype.processDataPack = async function(dataPackData, vlocityDataPackKey, addLastModifiedDate, matchingKeyFieldValue) {
    var sObjectType = dataPackData.VlocityRecordSObjectType;
    var vlocityDataPackType = dataPackData.VlocityDataPackType;
    var whereClauseHash = await this.buildUniqueKey(sObjectType, vlocityDataPackKey, dataPackData, matchingKeyFieldValue);

    if (whereClauseHash) {
        var whereClauseHashWithoutLastModifieDate = whereClauseHash;         

        if (addLastModifiedDate && this.lastModifiedDate) {
            // whereClauseHash = '((' + whereClauseHash + ') AND LastModifiedDate > ' + this.lastModifiedDate + ')';
        }

        if (vlocityDataPackType === 'SObject') {
            if (!this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType]) {
                this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType] = {};
            }

            if (!this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType]) {
                this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType] = {};    
            }

            this.deltaCheckJobInfo.whereClauseHashToVlocityDataPackKey[sObjectType][whereClauseHashWithoutLastModifieDate] = vlocityDataPackKey;
            
            this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType][whereClauseHashWithoutLastModifieDate] = dataPackData.VlocityRecordSourceKey;

            this.deltaCheckJobInfo.vlocityRecordSourceKeyToDataPackKey[dataPackData.VlocityRecordSourceKey] = vlocityDataPackKey;

            if (!this.querySObjectsInfo[sObjectType]) {
                this.querySObjectsInfo[sObjectType] = {};
            }
    
            if (!this.querySObjectsInfo[sObjectType][whereClauseHashWithoutLastModifieDate]) {
                this.querySObjectsInfo[sObjectType][whereClauseHashWithoutLastModifieDate] = {};
                this.querySObjectsInfo[sObjectType][whereClauseHashWithoutLastModifieDate].dataPack = dataPackData;
                this.querySObjectsInfo[sObjectType][whereClauseHashWithoutLastModifieDate].whereClause = whereClauseHash;
            }

            if (!this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType]) {
                this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType] = {};
            }

            this.deltaCheckJobInfo.contextDataToCompareAgainst[sObjectType][whereClauseHashWithoutLastModifieDate] = dataPackData;
        } else {
            if (!this.queryFieldsInfo[sObjectType]) {
                this.queryFieldsInfo[sObjectType] = {};
            }
    
            if (!this.queryFieldsInfo[sObjectType][whereClauseHashWithoutLastModifieDate]) {
                this.queryFieldsInfo[sObjectType][whereClauseHashWithoutLastModifieDate] = {};
                this.queryFieldsInfo[sObjectType][whereClauseHashWithoutLastModifieDate].dataPack = dataPackData;
                this.queryFieldsInfo[sObjectType][whereClauseHashWithoutLastModifieDate].whereClause = whereClauseHash;
            }
        }
    } else if (whereClauseHash === ""){
        this.jobInfo.deltaCheckResults[vlocityDataPackKey] = { status: 'Unknown' };
    }
};

DeltaCheck.prototype.addChildrenQueryIfExist = async function(sObjectType, sObject, vlocityRecordSourceKey) {
    if (sObject) {
        var queryForChildren = this.deltaCheckJobInfo.deltaQueryChildrenDefinition[sObjectType];

        if (!queryForChildren) {
            queryForChildren = this.vlocity.datapacksutils.getDeltaQueryChildren(null, this.vlocity.utilityservice.replaceNamespaceWithDefault(sObjectType));
        }

        if (queryForChildren) {
            queryForChildren = this.vlocity.utilityservice.checkNamespacePrefix(queryForChildren);
            this.deltaCheckJobInfo.deltaQueryChildrenDefinition[sObjectType] = queryForChildren;

            for (var childSObjectType in queryForChildren) {
                if (!this.deltaCheckJobInfo.queryForChildren[childSObjectType]) {
                    this.deltaCheckJobInfo.queryForChildren[childSObjectType] = [];
                }

                var queryRecord = { vlocityRecordSourceKey: vlocityRecordSourceKey };
                var idField;

                for (var fieldName in queryForChildren[childSObjectType]) {
                    var lookupField = queryForChildren[childSObjectType][fieldName];
                    var lookupFieldValue;

                    if (typeof(lookupField) === 'boolean') {
                        lookupFieldValue = lookupField;
                    } else {
                        lookupFieldValue = sObject[lookupField];
                        idField = fieldName;
                    }
                    
                    queryRecord[fieldName] = lookupFieldValue;
                }
                
                this.deltaCheckJobInfo.childToParentLookupField[childSObjectType] = { 
                    idField: idField, 
                    sObjectType : sObjectType
                };

                this.deltaCheckJobInfo.queryForChildren[childSObjectType].push(queryRecord);
            }
        }
    }
};

DeltaCheck.prototype.buildUniqueKey = async function(sObjectType, vlocityDataPackKey, sObject, matchingKeyFieldValue) {
    if (!this.sObjectInfo[sObjectType]) {
        this.sObjectInfo[sObjectType] = {};
    }
    
    if (!this.sObjectInfo[sObjectType].matchingKeyField) {
        this.sObjectInfo[sObjectType].matchingKeyField = this.vlocityMatchingKeys[sObjectType];   
    }

    if (!this.sObjectInfo[sObjectType].sObjectDescribe) {
        this.sObjectInfo[sObjectType].sObjectDescribe = await this.vlocity.utilityservice.describeSObject(sObjectType);;
    }

    if (!this.sObjectInfo[sObjectType].fieldsDefinitionsMap) {
        this.sObjectInfo[sObjectType].fieldsDefinitionsMap = this.vlocity.utilityservice.getFieldsDefinitionsMap(this.sObjectInfo[sObjectType].sObjectDescribe);
    }

    var matchingKeyField = this.sObjectInfo[sObjectType].matchingKeyField;
    
    if (matchingKeyField && matchingKeyField.includes(',')) {
        matchingKeyField = matchingKeyField.split(',');
        var referenceMatchingFieldFound = false;
        var sObjectRecord = {};

        for (var i = 0; i < matchingKeyField.length; i++) {
            if (this.sObjectInfo[sObjectType].fieldsDefinitionsMap[matchingKeyField[i]]) {
                var referenceSObject = sObject[matchingKeyField[i]];

                if (referenceSObject instanceof Object) {
                    referenceMatchingFieldFound = true;

                    if (referenceSObject.VlocityLookupRecordSourceKey) {
                        matchingKeyFieldValue = referenceSObject.VlocityLookupRecordSourceKey;
                    } else if (referenceSObject.VlocityMatchingRecordSourceKey) {
                        matchingKeyFieldValue = referenceSObject.VlocityMatchingRecordSourceKey;
                    }
                    
                    sObjectRecord[referenceSObject.VlocityRecordSObjectType] = {};
                    sObjectRecord[referenceSObject.VlocityRecordSObjectType][matchingKeyField[i]] = matchingKeyFieldValue;
                    matchingKeyFieldValue = '';
                } else {
                    sObjectRecord[matchingKeyField[i]] = referenceSObject;
                }
            }
        }

        if (vlocityDataPackKey && !this.vlocity.utilityservice.isEmptyObject(sObjectRecord)) {
            if (!this.deltaCheckJobInfo.generatedMatchingKeyValueToId
                [sObjectType]) {
                this.deltaCheckJobInfo.generatedMatchingKeyValueToId[sObjectType] = [];
            }

            var whereClause = this.buildWhereClauseHash(matchingKeyField, sObject, this.sObjectInfo[sObjectType].fieldsDefinitionsMap, sObjectType);

            if (!this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType]) {
                this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType] = {};
            }

            this.deltaCheckJobInfo.matchingKeyFieldToDataPack[sObjectType][whereClause] = sObject;
            sObjectRecord.vlocityDataPackKey = vlocityDataPackKey;
            this.deltaCheckJobInfo.generatedMatchingKeyValueToId[sObjectType].push(sObjectRecord);
        }

        if (referenceMatchingFieldFound) {
            return;
        }
    }

    if (matchingKeyFieldValue) {
        sObject[matchingKeyField] = matchingKeyFieldValue;
    }

    if (!matchingKeyField) {
        matchingKeyField = this.getDeltaCheckMatchingKeyFields(sObjectType, sObject);
    }

    if (!(matchingKeyField instanceof Array)) {
        matchingKeyField = [matchingKeyField];
    }

    return this.buildWhereClauseHash(matchingKeyField, sObject, this.sObjectInfo[sObjectType].fieldsDefinitionsMap, sObjectType);
};

DeltaCheck.prototype.getDeltaCheckMatchingKeyFields = function(sObjectType, sObject) {
    var deltaCheckMatchingKey = this.vlocity.datapacksutils.getDeltaCheckMatchingKey(sObjectType);

    if (deltaCheckMatchingKey) {
        var matchingKeyField = [];
        
        for (var matchField of deltaCheckMatchingKey) {
            if (typeof matchField  === 'string') {
                matchingKeyField.push(this.vlocity.utilityservice.checkNamespacePrefix(matchField));
            } else {
                var fieldKey = Object.keys(matchField)[0];
                matchingKeyField.push(this.vlocity.utilityservice.checkNamespacePrefix(fieldKey));

                sObject[this.vlocity.utilityservice.checkNamespacePrefix(fieldKey)] = matchField[fieldKey];
            }
        }

        return matchingKeyField;
    }

    return null;
}

DeltaCheck.prototype.buildWhereClauseHash = function(matchingKeyField, sObject, fieldsDefinitionsMap, sObjectType) {
    var fieldsValuesMap = {};
    var fieldsDefinitionsMapReduced = {};
    var matchingKeyFieldValue = '';
    
    if (matchingKeyField instanceof Array) {
        for (var i = 0; i < matchingKeyField.length; i++) {
            var matchingFieldValue = sObject[matchingKeyField[i]];

            if (!matchingFieldValue && typeof(matchingFieldValue) !== 'boolean') {
                matchingFieldValue = null;
            }

            if (matchingFieldValue instanceof Object) {
                if (matchingFieldValue.VlocityLookupRecordSourceKey) {
                    matchingFieldValue = matchingFieldValue.VlocityLookupRecordSourceKey.substring(matchingFieldValue.VlocityLookupRecordSourceKey.indexOf('/')+1);
                } else if (matchingFieldValue.VlocityMatchingRecordSourceKey) {
                    matchingFieldValue = matchingFieldValue.VlocityMatchingRecordSourceKey.substring(matchingFieldValue.VlocityMatchingRecordSourceKey.indexOf('/')+1);
                }
            }
            
            if (!fieldsValuesMap[matchingKeyField[i]]) {
                fieldsValuesMap[matchingKeyField[i]] = [];
            }

            fieldsDefinitionsMapReduced[matchingKeyField[i]] = fieldsDefinitionsMap[matchingKeyField[i]];
            fieldsValuesMap[matchingKeyField[i]].push(matchingFieldValue);
        }
    }

    var whereClauseHash = this.vlocity.queryservice.buildWhereClause(fieldsValuesMap, fieldsDefinitionsMapReduced);

    if (!this.deltaCheckJobInfo.matchingKeyFieldValueToWhereClauseHash[sObjectType]) {
        this.deltaCheckJobInfo.matchingKeyFieldValueToWhereClauseHash[sObjectType] = {};
    }

    if (sObject.VlocityRecordSourceKey) {
        matchingKeyFieldValue = sObject.VlocityRecordSourceKey;
    } else if (this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType] && this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType][whereClauseHash]) {
        matchingKeyFieldValue = this.deltaCheckJobInfo.whereClauseHashToVlocityRecordSourceKey[sObjectType][whereClauseHash];
    }

    if (matchingKeyFieldValue) {
        this.deltaCheckJobInfo.matchingKeyFieldValueToWhereClauseHash[sObjectType][matchingKeyFieldValue] = whereClauseHash;
    }

    return whereClauseHash;
};

DeltaCheck.prototype.getLastModifiedDate = function() {
    var srcpath = path.join(__dirname, '..', '..', 'vlocity-temp', 'deltaCheckJobInfo');
    var files = this.vlocity.datapacksutils.loadFilesAtPath(srcpath);
    var newLastModifiedDate = new Date().toISOString();
    
    if (files.deltaCheckJobInfo
        && files.deltaCheckJobInfo[this.vlocity.utilityservice.organizationId]) {
        this.lastModifiedDate = files.deltaCheckJobInfo[this.vlocity.utilityservice.organizationId];
    }
    
    fs.outputFileSync(path.join('vlocity-temp', 'deltaCheckJobInfo', this.vlocity.utilityservice.organizationId), newLastModifiedDate, 'utf8');
};

DeltaCheck.prototype.getMatchingKeyFieldValue = function(sObjectType, sObject) {
    var matchingKeyField = this.vlocityMatchingKeys[sObjectType];

    if (!matchingKeyField) {
        matchingKeyField = this.getDeltaCheckMatchingKeyFields(sObjectType, sObject);
    } else if (matchingKeyField.includes(',')) {
        matchingKeyField = matchingKeyField.split(',');
    }

    var matchingKeyFieldValue = '';

    if (matchingKeyField instanceof Array) {
        for (var i = 0; i < matchingKeyField.length; i++) {
            matchingKeyFieldValue += sObject[matchingKeyField[i]] ? sObject[matchingKeyField[i]] : null;
        }
    } else {
        matchingKeyFieldValue = sObject[matchingKeyField];
    }

    return matchingKeyFieldValue;
};