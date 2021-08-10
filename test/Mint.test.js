const hre = require("hardhat");
const {expect} = require("chai");
const {toUnitString, toUnit, divideDecimal, multiplyDecimal} = require('../utils/maths')
const assert = require('../utils/assert')
const {humanBN} = require("../utils/maths");
const {loadToken, deployToken, deployAndInitializeContract, randomAddress} = require("../utils/contract")

const CONTRACT_NAME = 'Mint';
let deployer, factory, collector, account1, account2, account3;
let mintInstance, oracleInstance, kalataOracleInstance;
let targetAsset, baseToken;
let protocolFeeRate;
let defaultConfig;
let priceExpireTime = 3600 * 24;

async function waitReceipt(promise) {
    let receipt = await promise
    let confirmations = await receipt.wait()
    return confirmations
}

async function preparePostion(hre, params) {
    await waitReceipt(kalataOracleInstance.registerAsset(params.assetToken, deployer.address));
    await waitReceipt(kalataOracleInstance.feedPrice(params.assetToken, params.assetTokenPrice.toString()));

    await waitReceipt(mintInstance.updateAsset(params.assetToken, params.auctionDiscount.toString(), params.minCollateralRatio.toString()))
    const tokenInstance = await loadToken(hre, params.collateralToken);
    await waitReceipt(tokenInstance.approve(mintInstance.address, params.collateralAmount.toString()));
    await waitReceipt(mintInstance.openPosition(params.collateralToken, params.collateralAmount.toString(), params.assetToken, params.collateralRatio.toString()));
    return await mintInstance.queryPositionIndex(deployer.address, params.collateralToken, params.assetToken)
}

describe(CONTRACT_NAME, () => {
    before(async () => {
        //we can mock factory and collector address, since they are just used for token transfer and permission check in Mint contract;
        [deployer, account1, account2, account3] = await hre.ethers.getSigners();
        factory = deployer.address;
        collector = deployer.address;
        baseToken = await deployToken(hre, "usd-token", "busd", toUnitString('1200000000000'));
        targetAsset = await deployToken(hre, "apple", "apple", toUnitString('1200000000000'));

        kalataOracleInstance = await deployAndInitializeContract(hre, "KalataOracle", [[], []])

        oracleInstance = await deployAndInitializeContract(hre, "Oracle", [[kalataOracleInstance.address]])
        expect(oracleInstance.address).to.properAddress;

        protocolFeeRate = toUnit("0.015");
        defaultConfig = {
            factory,
            oracle: oracleInstance.address,
            collector,
            baseToken: baseToken.address,
            protocolFeeRate: protocolFeeRate.toString(),
            priceExpireTime
        }

        mintInstance = await deployAndInitializeContract(hre, CONTRACT_NAME, [
            defaultConfig.factory,
            defaultConfig.oracle,
            defaultConfig.collector,
            defaultConfig.baseToken,
            defaultConfig.protocolFeeRate,
            defaultConfig.priceExpireTime
        ]);

        await targetAsset.registerMinters([mintInstance.address])
        expect(mintInstance.address).to.properAddress;
    });


    it("auction", async () => {
        let params = {
            collateralAmount: toUnit("2"),
            collateralRatio: toUnit("2.0"),
            assetTokenPrice: toUnit("2"),
            auctionDiscount: toUnit("0.2"),
            minCollateralRatio: toUnit("1.5"),
            collateralToken: baseToken.address,
            assetToken: targetAsset.address
        }

        let positionIndex = await preparePostion(hre, params);
        {
            let {positionOwner, collateralToken, collateralAmount, assetToken, assetAmount} = await mintInstance.queryPosition(positionIndex);
            console.log(positionOwner, collateralToken, collateralAmount, assetToken, assetAmount)
        }


        let {price} = await oracleInstance.queryPrice(params.assetToken);
        console.log('price', humanBN(price))

        expect(mintInstance.auction(positionIndex, toUnitString("11111"))).to.revertedWith("Mint: AUCTION_CANNOT_LIQUIDATE_SAFELY_POSITION");
        await kalataOracleInstance.feedPrice(params.assetToken, toUnitString("3.0")).catch(e => {
            console.error(`feedPrice:${e}`);
        })

        let maxCollateralAmount = toUnitString("11111");
        await baseToken.approve(mintInstance.address, maxCollateralAmount)
        await mintInstance.auction(positionIndex, maxCollateralAmount).catch(e => {
            console.log(`acution:${e}`);
        })
    });


});

function tested() {
    describe("Deployment", async () => {
        it("Should set the right owner", async () => {
            expect(await mintInstance.owner()).to.equal(deployer.address);
        });
    });
    describe("config", async () => {
        async function updateConfig(instance, config) {
            await instance.updateConfig(
                config.factory,
                config.oracle,
                config.collector,
                config.baseToken,
                config.protocolFeeRate,
                config.priceExpireTime
            )
        }

        function assertConfigEqual(config1, config2) {
            expect(config1.factory).to.equal(config2.factory);
            expect(config1.oracle).to.equal(config2.oracle);
            expect(config1.collector).to.equal(config2.collector);
            expect(config1.baseToken).to.equal(config2.baseToken);
            expect(config1.protocolFeeRate).to.equal(config2.protocolFeeRate);
            expect(config1.priceExpireTime).to.equal(config2.priceExpireTime);
        }

        it("queryConfig/updateConfig/permission", async () => {
            assertConfigEqual(defaultConfig, await mintInstance.queryConfig());
            let newConfig = {
                factory: randomAddress(hre),
                oracle: randomAddress(hre),
                collector: randomAddress(hre),
                baseToken: randomAddress(hre),
                protocolFeeRate: toUnitString("0.11"),
                priceExpireTime: 3600 * 72,

            };
            await updateConfig(mintInstance, newConfig);
            assertConfigEqual(newConfig, await mintInstance.queryConfig());
            await updateConfig(mintInstance, defaultConfig);

            assertConfigEqual(defaultConfig, await mintInstance.queryConfig());

            //Another account should have no permission to updateConfig
            let account1Instance = mintInstance.connect(account1);
            await expect(updateConfig(account1Instance, newConfig)).to.be.revertedWith("Ownable: caller is not the owner");

            //transfer ownership
            await mintInstance.transferOwnership(account1.address);

            //now another account should have permission to updateConfig
            await updateConfig(account1Instance, newConfig)
            assertConfigEqual(newConfig, await mintInstance.queryConfig());

            //transfer ownership back
            await account1Instance.transferOwnership(deployer.address);

            //update config back
            await updateConfig(mintInstance, defaultConfig);
            assertConfigEqual(defaultConfig, await mintInstance.queryConfig());
        });
    });
    describe("updateAsset", async () => {
        let assetToken = randomAddress(hre);
        let auctionDiscount = toUnit("0.8");
        let minCollateralRatio = toUnit("1.5");

        it("No permission", async () => {
            let account1Instance = mintInstance.connect(account1);
            await expect(account1Instance.updateAsset(assetToken, auctionDiscount.toString(), minCollateralRatio.toString()))
                .to.be.revertedWith("Unauthorized, only factory/owner can perform");
        });

        it("updateAsset() should work", async () => {
            await mintInstance.updateAsset(assetToken, auctionDiscount.toString(), minCollateralRatio.toString());
            let [auctionDiscount1, minCollateralRatio1] = await mintInstance.queryAssetConfig(assetToken);
            expect(auctionDiscount.toString()).to.equal(auctionDiscount1.toString());
            expect(minCollateralRatio.toString()).to.equal(minCollateralRatio1.toString());

        });
    });
    it("deposit() should work", async () => {
        let [collateralAmount, collateralRatio, assetTokenPrice, auctionDiscount, minCollateralRatio, collateralToken, assetToken] = [
            toUnit("2"), toUnit("2.0"), toUnit("2"), toUnit("0.8"), toUnit("1.5"), baseToken.address, targetAsset.address
        ];
        let positionIndex = await preparePostion(hre, {
            collateralAmount,
            collateralRatio,
            assetTokenPrice,
            auctionDiscount,
            minCollateralRatio,
            collateralToken,
            assetToken
        });

        const assetTokenInstance = await loadToken(hre, assetToken);
        let balanceBefore = await assetTokenInstance.balanceOf(deployer.address);

        let depositAmount = toUnit("1.2");

        const collateralTokenInstance = await loadToken(hre, collateralToken);

        await collateralTokenInstance.approve(mintInstance.address, depositAmount.toString());

        await mintInstance.deposit(positionIndex.toString(), collateralToken, depositAmount.toString());

        let balanceAfter = await assetTokenInstance.balanceOf(deployer.address);

        expect(balanceBefore.toString()).to.equal(balanceAfter.toString());
    });


    it("withdraw() should work", async () => {
        let [collateralAmount, collateralRatio, assetTokenPrice, auctionDiscount, minCollateralRatio, collateralToken, assetToken] = [
            toUnit("2"), toUnit("2.0"), toUnit("2"), toUnit("0.8"), toUnit("1.5"), baseToken.address, targetAsset.address
        ];
        let positionIndex = await preparePostion(hre, {
            collateralAmount,
            collateralRatio,
            assetTokenPrice,
            auctionDiscount,
            minCollateralRatio,
            collateralToken,
            assetToken
        });
        let withdrawAmount = toUnit("0.2");
        const collateralTokenInstance = await loadToken(hre, collateralToken);
        let balanceBefore = await collateralTokenInstance.balanceOf(collector);
        await mintInstance.withdraw(positionIndex.toString(), collateralToken, withdrawAmount.toString());
        let balanceAfter = await collateralTokenInstance.balanceOf(collector);
        assert.bnGt(balanceAfter, balanceBefore)
    });


    it("mint() should work", async () => {
        let [collateralAmount, collateralRatio, assetTokenPrice, auctionDiscount, minCollateralRatio, collateralToken, assetToken] = [
            toUnit("200"), toUnit("8.0"), toUnit("2"), toUnit("0.8"), toUnit("1.5"), baseToken.address, targetAsset.address
        ];
        let positionIndex = await preparePostion(hre, {
            collateralAmount,
            collateralRatio,
            assetTokenPrice,
            auctionDiscount,
            minCollateralRatio,
            collateralToken,
            assetToken
        });
        let mintAmount = toUnit("2");
        const postionBefore = await mintInstance.queryPosition(positionIndex.toString());
        await mintInstance.mint(positionIndex.toString(), assetToken, mintAmount.toString());
        const postionAfter = await mintInstance.queryPosition(positionIndex.toString());
        const difference = postionAfter.assetAmount - postionBefore.assetAmount;
        assert.equal(difference, mintAmount);
    });

    it("openPosition", async () => {
        let collateralAmount = toUnit("2");
        let collateralRatio = toUnit("2.0");
        let assetTokenPrice = toUnit("2");
        let auctionDiscount = toUnit("0.8");
        let minCollateralRatio = toUnit("1.5");
        let collateralToken = baseToken.address;
        let assetToken = targetAsset.address;

        let params = {
            collateralAmount,
            collateralRatio,
            assetTokenPrice,
            auctionDiscount,
            minCollateralRatio,
            collateralToken,
            assetToken
        }

        await preparePostion(hre, params);
        let collateralPrice = toUnit("1")
        let relativecollateralPrice = divideDecimal(collateralPrice, assetTokenPrice);
        let expectedBalanceDifference = divideDecimal(multiplyDecimal(relativecollateralPrice, collateralAmount), collateralRatio);
        expect('0').to.equal((relativecollateralPrice - expectedBalanceDifference).toString());
    });
}